// The app dev server listens on internal port 3000; public previews are exposed
// through the sandbox nginx reverse proxy on port 9000 under /preview/.
export const PREVIEW_SERVER_PORT = 3000;
export const PREVIEW_PUBLIC_PORT = 9000;
export const PREVIEW_PATH_PREFIX = '/preview/';
export const HISTORY_FETCH_LIMIT = 50;
export const AUTO_FIX_MAX_ATTEMPTS = 1;
export const BUILD_ERROR_PROMPT_LIMIT = 12000;
export const BUILD_RELATED_PATH_LIMIT = 12;
export const DEFAULT_MODEL = '@makers/minimax-m2.7';
export const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const GATEWAY_QUOTA_BYPASS_HEADER = 'X-Gateway-Quota-Bypass: true';
export const GATEWAY_QUOTA_PROMPT_HEADER = 'X-Prompt-Log: true';
export const GATEWAY_CONVERSATION_ID_HEADER_NAME = 'Makers-Conversation-Id';

export const SANDBOX_MCP_SERVER_NAME = 'edgeone-sandbox';

// Upper bound for the downloadable source archive, guarding against streaming an
// unexpectedly huge archive out of the sandbox and through the function response.
export const DOWNLOAD_ARCHIVE_MAX_BYTES = 60 * 1024 * 1024;

// Directories excluded from the downloadable source archive: build output,
// caches, and dependency/VCS folders that are large and regenerable.
export const ARCHIVE_EXCLUDED_DIRECTORIES = [
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
];


export const PREVIEW_BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.ogg', '.flac',
  '.lock',
]);

export const PREVIEW_MAX_BYTES = 256 * 1024;

export const FILE_TREE_IGNORED_DIRECTORIES = [
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
];

export const FILE_TREE_IGNORED_FILENAMES = new Set([
  'tsconfig.tsbuildinfo',
  '.DS_Store',
]);

export const BLOCKED_PROJECT_WRITE_SEGMENTS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  '.cache',
  '__pycache__',
]);

export const BLOCKED_PROJECT_WRITE_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.DS_Store',
]);

export const BLOCKED_PROJECT_WRITE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.ogg', '.flac',
  '.lock',
]);
