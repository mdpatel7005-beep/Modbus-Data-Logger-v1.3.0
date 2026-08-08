import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  AttributeIds,
  DataType,
  OPCUAClient,
  StatusCodes,
  Variant,
  type ClientSession,
} from "node-opcua";
import {
  ensureOpcUaCertificateIdentity,
  OpcUaPublisher,
  type OpcUaRuntimeCallbacks,
  type OpcUaServerRuntime,
} from "../src/services/opc-ua-publisher.js";
import type {
  OpcUaPublisherConfig,
  ProtocolPublicationSource,
  PublishedDevice,
} from "../src/services/protocol-publication.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function publishedDevice(value = 12.5): PublishedDevice {
  return {
    id: "device-a",
    name: "Boiler PLC",
    tags: [
      {
        id: "temperature",
        name: "Temperature",
        address: 100,
        functionCode: 3,
        dataType: "float32",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "degC",
        enabled: true,
        reading: {
          value,
          raw: [],
          quality: "good",
          timestamp: "2026-07-27T04:30:00.000Z",
          hasReading: true,
        },
      },
      {
        id: "unavailable",
        name: "Unavailable",
        address: 110,
        functionCode: 3,
        dataType: "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        enabled: true,
        reading: {
          value: null,
          raw: [],
          quality: "bad",
          timestamp: "2026-07-27T04:30:00.000Z",
          hasReading: false,
        },
      },
    ],
  };
}

function config(port: number, pkiDirectory: string): OpcUaPublisherConfig {
  return {
    enabled: true,
    host: "127.0.0.1",
    advertisedHost: "127.0.0.1",
    port,
    endpointPath: "/ModbusDataLoggerTest",
    allowAnonymous: true,
    refreshIntervalMs: 60_000,
    publishedDeviceIds: ["device-a"],
    pkiDirectory,
    shutdownTimeoutMs: 2_000,
  };
}

test(
  "publishes read-only OPC UA values with quality and source timestamps",
  { timeout: 30_000 },
  async () => {
    const port = await freePort();
    const pkiDirectory = await mkdtemp(
      join(tmpdir(), "modbus-data-logger-opcua-"),
    );
    let devices = [publishedDevice()];
    let sourceUnavailable = false;
    const source: ProtocolPublicationSource = {
      getPublishedDevices: async () => {
        if (sourceUnavailable) throw new Error("source unavailable");
        return structuredClone(devices);
      },
    };
    const publisher = new OpcUaPublisher(
      source,
      config(port, pkiDirectory),
    );
    const client = OPCUAClient.create({ endpointMustExist: false });
    let connected = false;
    let session: ClientSession | null = null;

    try {
      await publisher.start();
      const status = publisher.getStatus();
      assert.equal(status.state, "running");
      assert.equal(status.publishedDevices, 1);
      assert.equal(status.publishedTags, 2);
      assert(status.endpointUrl);

      await client.connect(status.endpointUrl);
      connected = true;
      const activeSession = await client.createSession();
      session = activeSession;

      const temperatureNode =
        "ns=1;s=Devices/device-a/temperature";
      const value = await activeSession.read({
        nodeId: temperatureNode,
        attributeId: AttributeIds.Value,
      });
      assert.equal(value.statusCode, StatusCodes.Good);
      assert.equal(value.value.value, 12.5);
      assert.equal(
        value.sourceTimestamp?.toISOString(),
        "2026-07-27T04:30:00.000Z",
      );

      const quality = await activeSession.readVariableValue(
        `${temperatureNode}/Quality`,
      );
      assert.equal(quality.value.value, "good");

      const unavailable = await activeSession.read({
        nodeId: "ns=1;s=Devices/device-a/unavailable",
        attributeId: AttributeIds.Value,
      });
      assert.equal(
        unavailable.statusCode,
        StatusCodes.BadNoCommunication,
      );
      assert.equal(unavailable.value.value, 0);

      devices = [publishedDevice(44.75)];
      await publisher.refresh();
      const updated = await activeSession.read({
        nodeId: temperatureNode,
        attributeId: AttributeIds.Value,
      });
      assert.equal(updated.value.value, 44.75);

      sourceUnavailable = true;
      await publisher.refresh();
      const unavailableAfterRefreshFailure = await activeSession.read({
        nodeId: temperatureNode,
        attributeId: AttributeIds.Value,
      });
      assert.equal(
        unavailableAfterRefreshFailure.statusCode,
        StatusCodes.BadNoCommunication,
      );
      assert.equal(unavailableAfterRefreshFailure.value.value, 0);
      assert.equal(publisher.getStatus().publishedDevices, 0);
      assert.equal(publisher.getStatus().publishedTags, 0);
      assert.match(
        publisher.getStatus().lastError ?? "",
        /Publication refresh failed: source unavailable/,
      );

      sourceUnavailable = false;
      await publisher.refresh();
      const recovered = await activeSession.read({
        nodeId: temperatureNode,
        attributeId: AttributeIds.Value,
      });
      assert.equal(recovered.statusCode, StatusCodes.Good);
      assert.equal(recovered.value.value, 44.75);
      assert.equal(publisher.getStatus().lastError, null);

      const writeStatus = await (
        activeSession as ClientSession & {
          writeSingleNode(
            nodeId: string,
            value: Variant,
          ): Promise<{ isGood(): boolean }>;
        }
      ).writeSingleNode(
        temperatureNode,
        new Variant({ dataType: DataType.Double, value: 999 }),
      );
      assert.equal(writeStatus.isGood(), false);
      assert(publisher.getStatus().connectedClients >= 1);
      assert(publisher.getStatus().requestCount > 0);
    } finally {
      if (session) await session.close().catch(() => {});
      if (connected) await client.disconnect().catch(() => {});
      await publisher.stop();
      await rm(pkiDirectory, { recursive: true, force: true });
    }

    assert.equal(publisher.getStatus().state, "stopped");
    assert.equal(publisher.getStatus().connectedClients, 0);
  },
);

test("startup failure is retained in status and does not escape to the collector", async () => {
  const source: ProtocolPublicationSource = {
    getPublishedDevices: async () => [publishedDevice()],
  };
  let runtimeCreated = false;
  const unusedRuntime: OpcUaServerRuntime = {
    getEndpointUrl: () => "",
    getConnectedClientCount: () => 0,
    getCurrentChannelCount: () => 0,
    getCurrentSessionCount: () => 0,
    getCurrentSubscriptionCount: () => 0,
    getRequestCount: () => 0,
    close: async () => {},
  };
  const publisher = new OpcUaPublisher(
    source,
    {
      ...config(4_840, "/absolute/public/opcua"),
      pkiDirectory: "/absolute/public/opcua",
    },
    async () => {
      runtimeCreated = true;
      return unusedRuntime;
    },
  );

  await publisher.start();

  assert.equal(runtimeCreated, false);
  assert.equal(publisher.getStatus().state, "error");
  assert.match(
    publisher.getStatus().lastError ?? "",
    /cannot be inside a public folder/,
  );
});

test("refresh rebuilds the OPC UA address space when the selected tag topology changes", async () => {
  let devices = [publishedDevice()];
  let starts = 0;
  let closes = 0;
  const topologySizes: number[] = [];
  const source: ProtocolPublicationSource = {
    getPublishedDevices: async () => structuredClone(devices),
  };
  const runtimeFactory = async (
    _config: OpcUaPublisherConfig,
    runtimeDevices: PublishedDevice[],
  ): Promise<OpcUaServerRuntime> => {
    starts += 1;
    topologySizes.push(
      runtimeDevices.reduce(
        (count, device) => count + device.tags.length,
        0,
      ),
    );
    return {
      getEndpointUrl: () => "opc.tcp://127.0.0.1:4840/test",
      getConnectedClientCount: () => 0,
      getCurrentChannelCount: () => 0,
      getCurrentSessionCount: () => 0,
      getCurrentSubscriptionCount: () => 0,
      getRequestCount: () => 0,
      close: async () => {
        closes += 1;
      },
    };
  };
  const publisher = new OpcUaPublisher(
    source,
    config(4_840, "/var/lib/modbus-data-logger/opcua"),
    runtimeFactory,
  );

  await publisher.start();
  const changed = publishedDevice();
  changed.tags.push({
    ...changed.tags[0]!,
    id: "flow",
    name: "Flow",
    address: 120,
  });
  devices = [changed];
  await publisher.refresh();

  assert.equal(publisher.getStatus().state, "running");
  assert.equal(publisher.getStatus().publishedTags, 3);
  assert.equal(starts, 2);
  assert.equal(closes, 1);
  assert.deepEqual(topologySizes, [2, 3]);

  await publisher.stop();
  assert.equal(closes, 2);
});

test("an empty OPC UA publication selection exposes no devices", async () => {
  const source: ProtocolPublicationSource = {
    getPublishedDevices: async () => [publishedDevice()],
  };
  let runtimeDeviceCount = -1;
  const publisher = new OpcUaPublisher(
    source,
    {
      ...config(4_840, "/var/lib/modbus-data-logger/opcua"),
      publishedDeviceIds: [],
    },
    async (
      _config,
      devices,
    ): Promise<OpcUaServerRuntime> => {
      runtimeDeviceCount = devices.length;
      return {
        getEndpointUrl: () => "opc.tcp://127.0.0.1:4840/test",
        getConnectedClientCount: () => 0,
        getCurrentChannelCount: () => 0,
        getCurrentSessionCount: () => 0,
        getCurrentSubscriptionCount: () => 0,
        getRequestCount: () => 0,
        close: async () => {},
      };
    },
  );

  await publisher.start();

  assert.equal(publisher.getStatus().state, "running");
  assert.equal(runtimeDeviceCount, 0);
  assert.equal(publisher.getStatus().publishedDevices, 0);
  await publisher.stop();
});

test("non-anonymous OPC UA requires and uses an authentication provider", async () => {
  const source: ProtocolPublicationSource = {
    getPublishedDevices: async () => [publishedDevice()],
  };
  const secureConfig = {
    ...config(4_840, "/var/lib/modbus-data-logger/opcua"),
    allowAnonymous: false,
  };
  let runtimeCreated = false;
  const noProvider = new OpcUaPublisher(
    source,
    secureConfig,
    async (): Promise<OpcUaServerRuntime> => {
      runtimeCreated = true;
      throw new Error("must not be called");
    },
  );

  await noProvider.start();
  assert.equal(runtimeCreated, false);
  assert.equal(noProvider.getStatus().state, "error");
  assert.match(
    noProvider.getStatus().lastError ?? "",
    /no authentication provider/,
  );

  let callbacks: OpcUaRuntimeCallbacks | null = null;
  const securePublisher = new OpcUaPublisher(
    source,
    secureConfig,
    async (
      _config,
      _devices,
      runtimeCallbacks,
    ): Promise<OpcUaServerRuntime> => {
      callbacks = runtimeCallbacks;
      return {
        getEndpointUrl: () => "opc.tcp://127.0.0.1:4840/test",
        getConnectedClientCount: () => 0,
        getCurrentChannelCount: () => 0,
        getCurrentSessionCount: () => 0,
        getCurrentSubscriptionCount: () => 0,
        getRequestCount: () => 0,
        close: async () => {},
      };
    },
    {
      validateCredentials: async (username, password) =>
        username === "monitor" && password === "simple",
    },
  );

  await securePublisher.start();
  assert.equal(securePublisher.getStatus().state, "running");
  const authenticate = (
    callbacks as OpcUaRuntimeCallbacks | null
  )?.authenticateUser;
  assert(authenticate);
  assert.equal(await authenticate("monitor", "simple"), true);
  assert.equal(await authenticate("monitor", "wrong"), false);
  await securePublisher.stop();
});

test("wildcard OPC UA binding requires a separate advertised host", async () => {
  const source: ProtocolPublicationSource = {
    getPublishedDevices: async () => [publishedDevice()],
  };
  let runtimeCreated = false;
  const missingAdvertisedHost = new OpcUaPublisher(
    source,
    {
      ...config(4_840, "/var/lib/modbus-data-logger/opcua"),
      host: "0.0.0.0",
      advertisedHost: undefined,
    },
    async (): Promise<OpcUaServerRuntime> => {
      runtimeCreated = true;
      throw new Error("must not be called");
    },
  );

  await missingAdvertisedHost.start();
  assert.equal(runtimeCreated, false);
  assert.equal(missingAdvertisedHost.getStatus().state, "error");
  assert.match(
    missingAdvertisedHost.getStatus().lastError ?? "",
    /advertised host is required/,
  );

  let receivedAdvertisedHost: string | undefined;
  const configured = new OpcUaPublisher(
    source,
    {
      ...config(4_840, "/var/lib/modbus-data-logger/opcua"),
      host: "0.0.0.0",
      advertisedHost: "logger.example.internal",
    },
    async (runtimeConfig): Promise<OpcUaServerRuntime> => {
      receivedAdvertisedHost = runtimeConfig.advertisedHost;
      return {
        getEndpointUrl: () =>
          "opc.tcp://logger.example.internal:4840/test",
        getConnectedClientCount: () => 0,
        getCurrentChannelCount: () => 0,
        getCurrentSessionCount: () => 0,
        getCurrentSubscriptionCount: () => 0,
        getRequestCount: () => 0,
        close: async () => {},
      };
    },
  );

  await configured.start();
  assert.equal(configured.getStatus().state, "running");
  assert.equal(
    receivedAdvertisedHost,
    "logger.example.internal",
  );
  await configured.stop();
});

test(
  "advertised-host change safely rotates the persisted self-signed certificate",
  { timeout: 30_000 },
  async () => {
    const pkiDirectory = await mkdtemp(
      join(tmpdir(), "modbus-data-logger-opcua-rotation-"),
    );
    const certificateFile = join(
      pkiDirectory,
      "own",
      "certs",
      "certificate.pem",
    );
    const privateKeyFile = join(
      pkiDirectory,
      "own",
      "private",
      "private_key.pem",
    );
    const source: ProtocolPublicationSource = {
      getPublishedDevices: async () => [publishedDevice()],
    };
    let initialPublisher: OpcUaPublisher | null = null;
    let changedPublisher: OpcUaPublisher | null = null;

    try {
      initialPublisher = new OpcUaPublisher(source, {
        ...config(await freePort(), pkiDirectory),
        advertisedHost: "logger-one.example",
      });
      await initialPublisher.start();
      assert.equal(initialPublisher.getStatus().state, "running");
      const initialCertificate = new X509Certificate(
        await readFile(certificateFile),
      );
      assert.equal(
        initialCertificate.checkHost("logger-one.example", {
          subject: "never",
        }),
        "logger-one.example",
      );
      const initialPrivateKey = await readFile(privateKeyFile);
      await initialPublisher.stop();
      initialPublisher = null;

      changedPublisher = new OpcUaPublisher(source, {
        ...config(await freePort(), pkiDirectory),
        advertisedHost: "logger-two.example",
      });
      await changedPublisher.start();
      const changedStatus = changedPublisher.getStatus();
      assert.equal(changedStatus.state, "running");
      assert(changedStatus.lastCertificateRotationAt);

      const changedCertificate = new X509Certificate(
        await readFile(certificateFile),
      );
      assert.equal(
        changedCertificate.checkHost("logger-two.example", {
          subject: "never",
        }),
        "logger-two.example",
      );
      assert.notEqual(
        changedCertificate.fingerprint256,
        initialCertificate.fingerprint256,
      );
      assert.deepEqual(await readFile(privateKeyFile), initialPrivateKey);
      assert.equal(
        (await readdir(join(pkiDirectory, "own", "certs"))).some(
          (name) => name.includes(".rotation-backup-"),
        ),
        false,
      );
    } finally {
      await initialPublisher?.stop().catch(() => {});
      await changedPublisher?.stop().catch(() => {});
      await rm(pkiDirectory, { recursive: true, force: true });
    }
  },
);

test("failed certificate rotation restores the previous certificate", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "modbus-data-logger-opcua-rollback-"),
  );
  const certificateFile = join(directory, "certificate.pem");
  const original = Buffer.from("known-good-certificate");
  await writeFile(certificateFile, original);
  let invalidations = 0;

  try {
    await assert.rejects(
      ensureOpcUaCertificateIdentity(
        {
          certificateFile,
          getCertificate: () => Buffer.alloc(0),
          checkCertificateSAN: () => ["logger-new.example"],
          regenerateSelfSignedCertificate: async () => {
            await writeFile(certificateFile, "partial-certificate");
            throw new Error("simulated certificate generation failure");
          },
          invalidateCachedCertificates: () => {
            invalidations += 1;
          },
          endpoints: [
            {
              invalidateCertificates: () => {
                invalidations += 1;
              },
            },
          ],
        },
        "logger-new.example",
      ),
      /previous certificate was restored/,
    );

    assert.deepEqual(await readFile(certificateFile), original);
    assert.equal(invalidations, 2);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.includes(".rotation-backup-"),
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a CA or GDS certificate is never replaced automatically", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "modbus-data-logger-opcua-ca-"),
  );
  const certificateFile = join(directory, "certificate.pem");
  const managedCertificate = Buffer.from("ca-managed-certificate");
  await writeFile(certificateFile, managedCertificate);

  try {
    await assert.rejects(
      ensureOpcUaCertificateIdentity(
        {
          certificateFile,
          getCertificate: () => Buffer.alloc(0),
          checkCertificateSAN: () => ["logger-new.example"],
          regenerateSelfSignedCertificate: async () => {
            throw new Error(
              "Cannot regenerate certificate: current certificate is not self-signed (issued by a CA or GDS)",
            );
          },
          invalidateCachedCertificates: () => {},
          endpoints: [],
        },
        "logger-new.example",
      ),
      /CA\/GDS certificate.*provision a replacement certificate/,
    );

    assert.deepEqual(
      await readFile(certificateFile),
      managedCertificate,
    );
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.includes(".rotation-backup-"),
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
