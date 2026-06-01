#!/bin/bash
shopt -s nullglob
for file in *.js; do
    if [[ "$file" != *.min.js ]]; then
        echo "Minifying $file..."
        npx terser "$file" -o "build/${file%.js}.min.js" --compress --mangle --toplevel
    fi
done
