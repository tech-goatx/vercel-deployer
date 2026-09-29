#!/bin/bash
cd "$(dirname "$0")"
npm install --omit=dev
npm start
