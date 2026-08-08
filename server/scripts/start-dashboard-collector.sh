#!/bin/bash
# Load nvm and start both dashboard and collector
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd /root/Modbus-Data-Logger-v1.3.0

# Run the combined dev command which starts both dashboard and collector
npm run dev
