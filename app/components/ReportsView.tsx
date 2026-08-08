"use client";

import { FileChartColumn, Table2 } from "lucide-react";
import { useState, useEffect } from "react";
import {
  fetchDevices,
} from "../lib/api";
import { SectionIntro } from "./CategoryAlarmsView";

interface ApiDevice {
  id: string;
  name: string;
  enabled: boolean;
}

export interface ReportsViewProps {
  connected: boolean;
  onToast: (text: string) => void;
  token?: string;
}

// Format timestamp to day-only string
function getDateString(timestamp: string): string {
  return new Date(timestamp).toISOString().split("T")[0];
}

export function ReportsView({
  connected,
  onToast,
  token,
}: ReportsViewProps) {
  const [reportDevices, setReportDevices] = useState<ApiDevice[]>([]);
  const [loading, setLoading] = useState(connected);
  const [tab, setTab] = useState<"device" | "plant">("device");
  
  // Device report filters
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [dataMode, setDataMode] = useState<"raw" | "downsample">("raw");
  
  // Report data display for device report
  const [deviceReportData, setDeviceReportData] = useState<any[]>([]);
  const [loadingDeviceReport, setLoadingDeviceReport] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!connected) return;
    let active = true;
    
    fetchDevices(token)
      .then((devices) => {
        if (active) {
          setReportDevices(devices);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError("Failed to load devices");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    
    return () => { active = false; };
  }, [connected, token]);

  async function fetchDeviceReportData() {
    if (!selectedDeviceId || !startDate || !endDate) {
      setError("Please select a device and date range");
      return;
    }

    setLoadingDeviceReport(true);
    setError("");

    try {
      const params = new URLSearchParams({
        deviceId: selectedDeviceId,
        limit: "50000",
      });

      if (startDate) {
        const from = `${startDate}T${startTime || "00:00:00"}`;
        params.append("from", from);
      }
      if (endDate) {
        const to = `${endDate}T${endTime || "23:59:59"}`;
        params.append("to", to);
      }
      if (dataMode === "downsample") params.append("downsampling", "1");

      const response = await fetch(`/api/v1/readings?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (!response.ok) {
        throw new Error("Failed to fetch readings");
      }

      const data = await response.json();
      
      // Process data with kWh calculation
      const processedData = processDeviceReportData(data);
      setDeviceReportData(processedData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load report data");
    } finally {
      setLoadingDeviceReport(false);
    }
  }

  // Process device report data with kWh calculation
  function processDeviceReportData(data: any[]): { 
    timestamp: string; 
    value: number; 
    kwh: number 
  }[] {
    if (!data || data.length === 0) return [];
    
    const sorted = [...data].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    
    if (sorted.length < 2) {
      // Not enough data for kWh calculation
      return sorted.map(row => ({
        timestamp: row.timestamp,
        value: Number(row.value) || 0,
        kwh: 0
      }));
    }
    
    const result = [];
    let prevValue = Number(sorted[0].value) || 0;
    
    for (let i = 1; i < sorted.length; i++) {
      const currentValue = Number(sorted[i].value) || 0;
      const diff = currentValue - prevValue;
      const kwh = diff > 0 ? diff : 0;
      
      result.push({
        timestamp: sorted[i].timestamp,
        value: currentValue,
        kwh: Math.round(kwh * 100) / 100
      });
      
      prevValue = currentValue;
    }
    
    return result;
  }

  // Calculate daily totals for plant report
  function calculateDailyTotals(): { date: string; kwh: number }[] {
    const dailyTotals: Record<string, number> = {};
    
    if (deviceReportData.length === 0) return [];
    
    // Get unique dates from device report data
    const uniqueDates = new Set(deviceReportData.map(d => getDateString(d.timestamp)));
    
    for (const date of uniqueDates) {
      dailyTotals[date] = 0;
    }
    
    for (let i = 1; i < deviceReportData.length; i++) {
      const prevRow = deviceReportData[i - 1];
      const currRow = deviceReportData[i];
      
      // Calculate kWh between consecutive readings
      const diff = Number(currRow.value) - Number(prevRow.value);
      if (diff > 0) {
        const day = getDateString(currRow.timestamp);
        dailyTotals[day] = (dailyTotals[day] || 0) + diff;
      }
    }
    
    return Object.entries(dailyTotals)
      .map(([date, kwh]) => ({ date, kwh: Math.round(kwh * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  const dailyTotals = calculateDailyTotals();
  const deviceReportDataForTable = deviceReportData;

  return (
    <>
      <SectionIntro
        eyebrow="Report Types"
        title="Reports"
        copy="Generate device-specific or plant-wide energy reports with customizable date ranges and data modes."
      />

      {/* Tabs */}
      <div className="panel report-filter-panel">
        <div className="panel-header">
          <div className="panel-title">
            <h3>Report Type</h3>
            <p>Select the type of report to generate.</p>
          </div>
          <FileChartColumn size={17} color="#086c58" />
        </div>
        
        <div className="report-type-tabs">
          <button
            className={`tab-button ${tab === "device" ? "active" : ""}`}
            onClick={() => setTab("device")}
          >
            Device Report
          </button>
          <button
            className={`tab-button ${tab === "plant" ? "active" : ""}`}
            onClick={() => setTab("plant")}
          >
            Plant Report
          </button>
        </div>

        {error && (
          <p className="login-error postgres-page-error" role="alert">
            {error}
          </p>
        )}

        {/* Device Report Tab */}
        {tab === "device" && (
          <>
            <section className="panel report-filter-panel">
              <div className="panel-header">
                <div className="panel-title">
                  <h3>Device Filters</h3>
                  <p>Select device and date/time range for the report.</p>
                </div>
                <Table2 size={17} color="#086c58" />
              </div>

              <div className="report-filter-grid">
                <div className="form-group">
                  <label htmlFor="report-device">Device</label>
                  <select
                    className="form-control"
                    disabled={loading}
                    id="report-device"
                    onChange={(event) => setSelectedDeviceId(event.target.value)}
                    value={selectedDeviceId}
                  >
                    <option value="">Select a device</option>
                    {reportDevices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="start-date">Start Date</label>
                  <input
                    type="date"
                    className="form-control"
                    id="start-date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="end-date">End Date</label>
                  <input
                    type="date"
                    className="form-control"
                    id="end-date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="start-time">Start Time</label>
                  <input
                    type="time"
                    className="form-control"
                    id="start-time"
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="end-time">End Time</label>
                  <input
                    type="time"
                    className="form-control"
                    id="end-time"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="data-mode">Data Mode</label>
                  <select
                    className="form-control"
                    id="data-mode"
                    value={dataMode}
                    onChange={(event) => setDataMode(event.target.value as "raw" | "downsample")}
                  >
                    <option value="raw">Raw data (all readings)</option>
                    <option value="downsample">Downsampled (aggregated)</option>
                  </select>
                </div>

                <div className="report-actions">
                  <button
                    className="button primary"
                    disabled={
                      !connected || loadingDeviceReport || !selectedDeviceId || !startDate
                    }
                    onClick={() => void fetchDeviceReportData()}
                    type="button"
                  >
                    {loadingDeviceReport ? "Loading..." : "Generate Device Report"}
                  </button>
                </div>
              </div>
            </section>

            {/* Display report data if available */}
            {deviceReportDataForTable.length > 0 && (
              <section className="panel table-panel report-data-table">
                <div className="panel-header">
                  <div className="panel-title">
                    <h3>Device Report Data</h3>
                    <p>Showing readings with calculated kWh values (difference between consecutive readings).</p>
                  </div>
                </div>

                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Value</th>
                        <th>kWh (Diff)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deviceReportDataForTable.map((row, index) => (
                        <tr key={index}>
                          <td className="table-primary">{row.timestamp}</td>
                          <td>{row.value.toFixed(2)}</td>
                          <td>{row.kwh.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}

        {/* Plant Report Tab */}
        {tab === "plant" && (
          <>
            <section className="panel report-filter-panel">
              <div className="panel-header">
                <div className="panel-title">
                  <h3>Plant-wide Filters</h3>
                  <p>Select date range for plant-wide energy report.</p>
                </div>
                <Table2 size={17} color="#086c58" />
              </div>

              <div className="report-filter-grid">
                <div className="form-group">
                  <label htmlFor="plant-start-date">Start Date</label>
                  <input
                    type="date"
                    className="form-control"
                    id="plant-start-date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="plant-end-date">End Date</label>
                  <input
                    type="date"
                    className="form-control"
                    id="plant-end-date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="plant-start-time">Start Time</label>
                  <input
                    type="time"
                    className="form-control"
                    id="plant-start-time"
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="plant-end-time">End Time</label>
                  <input
                    type="time"
                    className="form-control"
                    id="plant-end-time"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="plant-data-mode">Data Mode</label>
                  <select
                    className="form-control"
                    id="plant-data-mode"
                    value={dataMode}
                    onChange={(event) => setDataMode(event.target.value as "raw" | "downsample")}
                  >
                    <option value="raw">Raw data (all readings)</option>
                    <option value="downsample">Downsampled (aggregated)</option>
                  </select>
                </div>

                {/* Plant report doesn't need a button - daily totals are shown when device report is loaded */}
              </div>
            </section>

            {/* Display daily totals for all devices */}
            {dailyTotals.length > 0 && (
              <section className="panel table-panel report-data-table">
                <div className="panel-header">
                  <div className="panel-title">
                    <h3>Daily kWh Totals</h3>
                    <p>Sum of energy consumption for each day (calculated from device readings).</p>
                  </div>
                </div>

                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Total kWh</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyTotals.map((row, index) => (
                        <tr key={index}>
                          <td className="table-primary">{row.date}</td>
                          <td>{Math.round(row.kwh)} kWh</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
