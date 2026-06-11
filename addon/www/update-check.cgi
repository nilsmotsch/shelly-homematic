#!/bin/sh
echo "Content-Type: text/plain"
echo ""
cat /usr/local/addons/shelly-homematic/VERSION 2>/dev/null || echo "0.0.0"
