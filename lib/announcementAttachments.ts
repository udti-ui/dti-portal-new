import 'server-only';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const announcementAttachmentBucket = 'announcements';
export const maxAnnouncementAttachmentBytes = 5 * 1024 * 1024;

const allowedTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const safeFileName = (name: string) =>
  name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 160) || 'attachment';

const matchesType = (type: string, bytes: Uint8Array) => {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10';
  if (type === 'image/gif') return /^GIF8[79]a$/.test(new TextDecoder().decode(bytes.slice(0, 6)));
  if (type === 'image/webp') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  }
  if (type === 'application/pdf') return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
  if (type === 'application/msword') return bytes.slice(0, 8).join(',') === '208,207,17,224,161,177,26,225';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return bytes[0] === 0x50 && bytes[1] === 0x4b;
  }
  if (type === 'text/plain') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(new TextDecoder().decode(bytes));
    } catch {
      return false;
    }
  }
  return false;
};

export async function uploadAnnouncementAttachment(
  supabase: SupabaseClient,
  file: File | null
) {
  if (!file) return { attachment: null, error: null };
  const type = file.type.toLowerCase();
  if (!file.size || file.size > maxAnnouncementAttachmentBytes || !allowedTypes.has(type)) {
    return { attachment: null, error: 'announcement-attachment-invalid' };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!matchesType(type, bytes)) return { attachment: null, error: 'announcement-attachment-invalid' };

  const name = safeFileName(file.name);
  const path = `${randomUUID()}-${name}`;
  const { error } = await supabase.storage.from(announcementAttachmentBucket).upload(path, bytes, {
    contentType: type,
    cacheControl: '3600',
    upsert: false,
  });
  if (error) {
    console.error('ANNOUNCEMENT_ATTACHMENT_UPLOAD_FAILED:', error.message);
    return { attachment: null, error: 'announcement-attachment-save-failed' };
  }

  return {
    attachment: {
      attachment_path: path,
      attachment_name: name,
      attachment_type: type,
      attachment_size: file.size,
    },
    error: null,
  };
}

export async function removeAnnouncementAttachment(supabase: SupabaseClient, path: string) {
  const { error } = await supabase.storage.from(announcementAttachmentBucket).remove([path]);
  if (error) console.error('ANNOUNCEMENT_ATTACHMENT_ROLLBACK_FAILED:', error.message);
}

export const isAnnouncementAttachmentTypeAllowed = (type: string) => allowedTypes.has(type);
