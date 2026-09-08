#!/bin/bash

# Usage: ytdlup <url> [--title <title>] [--visibility public|unlisted|private] [--keep-file]
# Downloads <url> via yt-dlp and uploads it to justintube (see clone.js and README.md).
# Requires migration-tools/.env to be set up with JUSTINTUBE_API_BASE_URL and JUSTINTUBE_API_KEY.

# You may want to also add this to your shell PATH or maybe alias it or whatever.

# Check if URL parameter is provided
if [ -z "$1" ]; then
    echo "Error: Please provide a URL as parameter"
    echo "Usage: ./ytdlup.sh <URL> [--title <title>] [--visibility public|unlisted|private] [--keep-file]"
    exit 1
fi

# Call the Node.js script, forwarding all arguments
node "/Users/justin/Code/justintube/migration-tools/clone.js" "$@"
