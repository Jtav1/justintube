# justintube-ytdlp

Express API that downloads videos with [yt-dlp](https://github.com/yt-dlp/yt-dlp) into `MEDIA_STORAGE_DIRECTORY`.

Basically this is a separate container that runs a basic api and yt-dlp (and supporting software) so that the justintube website can call it in order to download a video from a link to an external site. All it does right now is take a url and shit out a file to a specified directory. This way you can point to that directory with the justintube view app, and then let the user provide a url instead of a file for a video upload. That should work probably.

Files are stored with an epoch timestamp (appended with alpha chars if duplicates exist) and the justintube view SHOULD (I will forget to do this) delete the file upon successful upload to justintube.

## Setup

```bash
cp .env.example .env
npm install
```

Requires Docker for `dev` / `start`

## Run

| Script        | What it does                                    |
| ------------- | ----------------------------------------------- |
| `npm run dev` | Build image and run container on port 3001      |
| `npm start`   | Start via root `docker-compose` `ytdlp` service |

## API

`GET /health` — liveness

`POST /download` — JSON body `{ "url": "https://..." }`

```bash
curl -X POST http://localhost:3001/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=…"}'
```

Success: `{ "success": true, "filename": "<epoch>.<ext>" }`  
Error: `{ "success": false, "error": "…" }`
