/**
 * Row cap per /api/import-csv request. Each row costs a couple of DB
 * round-trips, so the cap keeps one request well inside the route's
 * maxDuration; the uploader splits larger files into sequential batches of
 * this size. Shared so the client and server can't drift.
 */
export const MAX_ROWS_PER_REQUEST = 500;
