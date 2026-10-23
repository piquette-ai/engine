/** Node-free: the file types a journey may leave as evidence (#235). SVG and HTML are excluded on purpose, they can run script. */
export const EVIDENCE_CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json",
};
export const EVIDENCE_EXTENSIONS = Object.keys(EVIDENCE_CONTENT_TYPES) as [string, ...string[]];
export const DEFAULT_EVIDENCE_MAX_FILE_MB = 50;
export const DEFAULT_EVIDENCE_MAX_TOTAL_MB = 200;
