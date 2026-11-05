import 'server-only';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const courseLectureBucket = 'course-lectures';
export const maxCourseLectureFileBytes = 20 * 1024 * 1024;

export async function ensureCourseLectureBucket(supabase: SupabaseClient) {
  const storage = supabase.storage;
  const { data: bucket, error: lookupError } = await storage.getBucket(courseLectureBucket);
  if (bucket) {
    const allowedMimeTypes = bucket.allowed_mime_types ?? [];
    if (!bucket.public
      && bucket.file_size_limit === maxCourseLectureFileBytes
      && allowedMimeTypes.length === 1
      && allowedMimeTypes[0] === 'application/pdf') {
      return null;
    }
    const { error: updateError } = await storage.updateBucket(courseLectureBucket, {
      public: false,
      fileSizeLimit: maxCourseLectureFileBytes,
      allowedMimeTypes: ['application/pdf'],
    });
    if (!updateError) return null;
    console.error('COURSE_LECTURE_BUCKET_UPDATE_FAILED:', {
      status: updateError.status,
      statusCode: updateError.statusCode,
      message: updateError.message,
    });
    return 'lecture-storage-configuration-failed';
  }

  const bucketMissing = lookupError?.status === 404
    || lookupError?.statusCode === '404'
    || lookupError?.statusCode === 'BucketNotFound';
  if (!bucketMissing) {
    console.error('COURSE_LECTURE_BUCKET_LOOKUP_FAILED:', {
      status: lookupError?.status,
      statusCode: lookupError?.statusCode,
      message: lookupError?.message,
    });
    return 'lecture-storage-configuration-failed';
  }

  const { error: createError } = await storage.createBucket(courseLectureBucket, {
    public: false,
    fileSizeLimit: maxCourseLectureFileBytes,
    allowedMimeTypes: ['application/pdf'],
  });
  if (!createError) return null;

  const { data: createdByAnotherRequest } = await storage.getBucket(courseLectureBucket);
  if (createdByAnotherRequest) return null;

  console.error('COURSE_LECTURE_BUCKET_CREATE_FAILED:', {
    status: createError.status,
    statusCode: createError.statusCode,
    message: createError.message,
  });
  return 'lecture-storage-configuration-failed';
}

export async function uploadCourseLecture(
  supabase: SupabaseClient,
  file: File | null
) {
  if (!file || file.type.toLowerCase() !== 'application/pdf'
    || !file.size || file.size > maxCourseLectureFileBytes) {
    return { attachment: null, error: 'lecture-pdf-invalid' };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') {
    return { attachment: null, error: 'lecture-pdf-invalid' };
  }

  const bucketError = await ensureCourseLectureBucket(supabase);
  if (bucketError) return { attachment: null, error: bucketError };

  const name = file.name;
  const path = randomUUID();
  const { error } = await supabase.storage.from(courseLectureBucket).upload(path, bytes, {
    contentType: 'application/pdf',
    cacheControl: '3600',
    upsert: false,
  });
  if (error) {
    console.error('COURSE_LECTURE_UPLOAD_FAILED:', error.message);
    return { attachment: null, error: 'lecture-upload-failed' };
  }

  return {
    attachment: {
      file_path: path,
      file_name: name,
      file_size: file.size,
    },
    error: null,
  };
}

export async function removeCourseLectureFile(supabase: SupabaseClient, path: string) {
  const { error } = await supabase.storage.from(courseLectureBucket).remove([path]);
  if (error) console.error('COURSE_LECTURE_FILE_CLEANUP_FAILED:', error.message);
}
