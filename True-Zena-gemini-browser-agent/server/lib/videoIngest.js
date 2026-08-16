// Wraps yt-dlp to pull a low-bandwidth copy of a social video down to a
// temp directory before it gets handed to the Gemini Files API. Part 2 of
// the brief ("Downsample ingested media... to minimize bandwidth usage")
// and Part 3.4 ("audio-only... instead of full video files") both land
// here: audioOnly picks the extraction path, otherwise a capped
// low-resolution video is requested.
//
// Security notes, since this shells out to an external binary based on
// user input:
//   - The URL's hostname must match an allow-list before yt-dlp ever
//     sees it - this is not a general-purpose downloading proxy.
//   - yt-dlp is always invoked via spawn() with an argument array, never
//     a shell string, so there is no command-injection surface from the
//     URL or any other value.
//   - A hard process timeout and yt-dlp's own --max-filesize/
//     --match-filter duration limit bound worst-case resource usage.

import { spawn } from "node:child_process";
import { access, constants, mkdir, mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpError } from "./respond.js";

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "tiktok.com",
  "www.tiktok.com",
  "vm.tiktok.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "fb.watch",
]);

const MIME_BY_EXT = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

export function isSupportedVideoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function fetchMedia({ url, audioOnly }) {
  if (!isSupportedVideoUrl(url)) {
    throw httpError(400, "That link isn't from a supported platform (YouTube, TikTok, X/Twitter, or Facebook).");
  }

  const ytDlpPath = process.env.YT_DLP_PATH?.trim() || "yt-dlp";
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
  const cookiesPath = process.env.YT_DLP_COOKIES_PATH?.trim();
  const maxDurationSeconds = Number(process.env.MAX_VIDEO_DURATION_SECONDS) || 600;
  const maxFilesizeMb = Number(process.env.MAX_VIDEO_FILESIZE_MB) || 60;

  const dir = await mkdtemp(path.join(await resolveTmpRoot(), "truezena-"));
  const outputTemplate = path.join(dir, "media.%(ext)s");

  const args = [
    url,
    "--no-playlist",
    "--no-progress",
    "--newline",
    "-o",
    outputTemplate,
    "--max-filesize",
    `${maxFilesizeMb}M`,
    "--match-filter",
    `duration <= ${maxDurationSeconds}`,
    "--socket-timeout",
    "20",
    "--ffmpeg-location",
    ffmpegPath,
  ];

  // YouTube (and, less often, other platforms) blocks anonymous requests
  // from datacenter IPs like Render's with "Sign in to confirm you're not
  // a bot." Passing a cookies.txt from a real logged-in session gets past
  // that check. Optional: only added when YT_DLP_COOKIES_PATH is set.
  if (cookiesPath) {
    args.push("--cookies", cookiesPath);
  }

  if (audioOnly) {
    args.push("-x", "--audio-format", "m4a", "--audio-quality", "5");
  } else {
    // Cap resolution and merge to mp4 so Gemini gets a small, uniform file
    // instead of whatever the platform's best-quality stream happens to be.
    args.push("-f", `bv*[height<=480][filesize<${maxFilesizeMb}M]+ba/b[height<=480]/worst`, "--merge-output-format", "mp4");
  }

  try {
    await runYtDlp(ytDlpPath, args);

    const files = (await readdir(dir)).filter((name) => !name.startsWith("."));
    if (files.length === 0) {
      throw httpError(502, "yt-dlp did not produce an output file for that link.");
    }

    const outputPath = path.join(dir, files[0]);
    const ext = path.extname(files[0]).slice(1).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] || "application/octet-stream";
    const buffer = await readFile(outputPath);

    return {
      buffer,
      mimeType,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function runYtDlp(ytDlpPath, args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(httpError(504, "The video took too long to download. Try the audio-only option or a shorter clip."));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(
          httpError(
            500,
            `yt-dlp was not found at "${ytDlpPath}". Install it (pip install yt-dlp) and ffmpeg, or set YT_DLP_PATH/FFMPEG_PATH.`
          )
        );
      } else {
        reject(error);
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
      if (/match.?filter/i.test(tail) || /does not pass filter/i.test(tail)) {
        reject(httpError(400, `That video is longer than the ${Math.round(timeoutMs / 1000)}s-safe limit for this demo.`));
      } else {
        reject(httpError(502, `yt-dlp could not fetch that link${tail ? `: ${tail}` : "."}`));
      }
    });
  });
}

async function resolveTmpRoot() {
  // Prefer a project-local tmp dir (gitignored) so it's easy to find and
  // clean up during development; fall back to the OS temp dir anywhere
  // that path isn't writable (e.g. a read-only deployment image).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectTmp = path.join(here, "..", "tmp");
  try {
    await mkdir(projectTmp, { recursive: true });
    await access(projectTmp, constants.W_OK);
    return projectTmp;
  } catch {
    return tmpdir();
  }
}
