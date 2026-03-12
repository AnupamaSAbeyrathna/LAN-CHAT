/**
 * crypto.js — E2E Encryption Utilities
 *
 * Algorithm: AES-256-GCM (authenticated encryption)
 * Key size:  32 bytes (256-bit)
 * IV size:   12 bytes (96-bit, GCM standard)
 * Auth tag:  16 bytes appended to ciphertext
 *
 * No external dependencies — uses Node.js built-in `node:crypto` only.
 */

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

/**
 * Generate a cryptographically random 32-byte room key.
 * @returns {Buffer}
 */
export function generateRoomKey() {
    return crypto.randomBytes(32);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * @param {Buffer} key        - 32-byte room key
 * @param {string} plaintext  - Message to encrypt
 * @returns {{ iv: string, cipher: string, tag: string }} Base64-encoded fields
 */
export function encrypt(key, plaintext) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    return {
        iv: iv.toString('base64'),
        cipher: encrypted.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
    };
}

/**
 * Decrypt an AES-256-GCM ciphertext.
 * @param {Buffer} key     - 32-byte room key
 * @param {string} iv      - Base64-encoded IV
 * @param {string} cipher  - Base64-encoded ciphertext
 * @param {string} tag     - Base64-encoded auth tag
 * @returns {string} Decrypted plaintext
 * @throws If decryption or authentication fails
 */
export function decrypt(key, iv, cipher, tag) {
    const decipher = crypto.createDecipheriv(
        ALGO,
        key,
        Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(cipher, 'base64')),
        decipher.final(),
    ]);
    return decrypted.toString('utf8');
}

/**
 * Encode a Buffer key as a hex string (for transmission).
 * @param {Buffer} key
 * @returns {string}
 */
export function keyToHex(key) {
    return key.toString('hex');
}

/**
 * Decode a hex string back to a Buffer key.
 * @param {string} hex
 * @returns {Buffer}
 */
export function hexToKey(hex) {
    return Buffer.from(hex, 'hex');
}

/**
 * Returns the first 8 hex chars of SHA-256(key) as a human-readable fingerprint.
 * Broadcast in UDP announces so joiners can find the creator.
 * @param {Buffer} key
 * @returns {string} e.g. "a1b2c3d4"
 */
export function fingerprint(key) {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * Strip ANSI escape sequences and NUL bytes from untrusted peer input.
 * Prevents terminal injection via crafted peer names or messages.
 * @param {string} str
 * @returns {string}
 */
export function sanitize(str) {
    if (typeof str !== 'string') return '';
    // Remove ANSI/VT escape sequences
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x00/g, '')
        .slice(0, 512); // Hard cap on length
}
