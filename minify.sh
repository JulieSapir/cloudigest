#!/bin/bash

npx terser snippets.js -o snippets.min.js --compress --mangle --toplevel
