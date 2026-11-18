import crypto from 'node:crypto';

function getEncryptionKey(): Buffer {
  const secret = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY must contain at least 32 characters to store source credentials.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSourceAuth(authConfig: Record<string, unknown> | null | undefined): string | null {
  if (!authConfig || Object.keys(authConfig).length === 0) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(authConfig), 'utf8'),
    cipher.final(),
  ]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSourceAuth(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const [version, ivText, tagText, encryptedText] = value.split(':');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) {
    throw new Error('Stored source credentials use an unsupported encryption format.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed: unknown = JSON.parse(decrypted);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored source credentials are not a valid object.');
  }
  return parsed as Record<string, unknown>;
}
