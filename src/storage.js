/* Rider documents live in an S3-compatible bucket. The API only ever hands out short-lived signed
   URLs: a rider uploads straight to storage with a signed PUT, an admin reads with a signed GET, and
   the keys never reach the browser. */
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, storageConfigured } from './config.js';
import { ApiError } from './validate.js';

export const DOCUMENT_KINDS = ['national_id', 'driving_licence', 'plate', 'trading_licence'];
export const DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/* A trading licence is issued as a paper PDF, so that kind alone also accepts a photo of the paper.
   Every other document is a photograph of something plastic or metal, and a PDF in its place is
   something wrong with the upload, so the kind decides what the bucket will take. */
export const DOCUMENT_TYPES_BY_KIND = {
  national_id: ['image/jpeg', 'image/png', 'image/webp'],
  driving_licence: ['image/jpeg', 'image/png', 'image/webp'],
  plate: ['image/jpeg', 'image/png', 'image/webp'],
  trading_licence: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
};

export const documentTypesFor = (kind) => DOCUMENT_TYPES_BY_KIND[kind] || DOCUMENT_TYPES;

export const acceptsType = (kind, contentType) => documentTypesFor(kind).includes(String(contentType || '').toLowerCase());

let client = null;

const s3 = () => {
  if (!storageConfigured()) {
    throw new ApiError(503, 'storage_not_configured', 'Document storage is not configured on this server');
  }
  client ??= new S3Client({
    region: config.storage.region,
    ...(config.storage.endpoint ? { endpoint: config.storage.endpoint } : {}),
    forcePathStyle: config.storage.forcePathStyle,
    /* Browsers cannot compute AWS's default CRC32 checksum while uploading a presigned PUT, so only
       add one when the bucket policy explicitly demands it. */
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
  });
  return client;
};

export const storageHealth = () => ({
  configured: storageConfigured(),
  bucket: config.storage.bucket || null,
  maxUploadBytes: config.storage.maxUploadBytes,
});

/* What the signup page needs before it offers a licence upload: whether a bucket is reachable at all,
   and how big a file it will take. */
export const documentHealth = () => ({
  configured: storageConfigured(),
  maxBytes: config.storage.maxUploadBytes,
});

export const documentKey = (driverId, kind) => `riders/${driverId}/${kind}`;

export const presignUpload = (key, contentType) => getSignedUrl(
  s3(),
  new PutObjectCommand({ Bucket: config.storage.bucket, Key: key, ContentType: contentType }),
  { expiresIn: config.storage.signedUrlTtlSeconds },
);

export const presignDownload = (key) => getSignedUrl(
  s3(),
  new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }),
  { expiresIn: config.storage.signedUrlTtlSeconds },
);

export async function headObject(key) {
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: config.storage.bucket, Key: key }));
    return { bytes: head.ContentLength ?? 0, contentType: head.ContentType || null };
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return null;
    throw error;
  }
}

export const documentShape = (row) => ({
  kind: row.kind,
  status: row.status,
  contentType: row.content_type,
  bytes: row.bytes,
  uploadedAt: row.uploaded_at,
  note: row.note,
});
