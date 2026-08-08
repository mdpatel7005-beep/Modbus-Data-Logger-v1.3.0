#!/bin/bash
# Load nvm and start the collector
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd /root/Modbus-Data-Logger-v1.3.0
npm --prefix server run dev:collector
