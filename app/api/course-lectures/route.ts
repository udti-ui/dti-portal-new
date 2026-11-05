import { randomUUID, timingSafeEqual, scryptSync } from 'crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../lib/supabaseAdmin';
import { normalizeStudentYear } from '../../../lib/studentData';
import { verifyFirstDegreeSupervisor } from '../../../lib/supervisorAuth';
import { notifyStudentsAboutAnnouncement } from '../../../lib/announcementNotifications';
import {
  courseLectureBucket,
  ensureCourseLectureBucket,
  maxCourseLectureFileBytes,
  removeCourseLectureFile,
  uploadCourseLecture,
} from '../../../lib/courseLectureFiles';

export const dynamic = 'force-dynamic';

type LectureRequest = {
  action?: string;
  studentId?: string;
  password?: string;
  username?: string;
  supervisorUsername?: string;
  supervisorPassword?: string;
  subject?: string;
  studentYear?: string;
  lectureId?: string | number;
  title?: string;
  path?: string;
  fileName?: string;
  fileSize?: number | string;
  fileType?: string;
  file?: File;
};

type TeacherRow = {
  id: string;
  teacher_name: string;
  is_active: boolean;
  password_hash?: string | null;
};

type Assignment = {
  name: string;
  year: 'أولى' | 'ثانية';
};

const clean = (value: unknown) => String(value ?? '').trim();
const downloadFileName = (subject: string, title: string) => {
  const baseName = `${subject} - ${title}`
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180)
    .trim();
  return `${baseName || 'محاضرة'}.pdf`;
};
const errorResponse = (error: string, status: number) =>
  NextResponse.json({ success: false, error }, { status });
const databaseFailure = (operation: string, error: { code?: string; message?: string }) => {
  console.error(`COURSE_LECTURE_${operation.toUpperCase()}_FAILED:`, {
    code: error.code,
    message: error.message,
  });
  if (error.code === 'PGRST205' || /does not exist|relation|not found|could not find the .*column/i.test(error.message ?? '')) {
    return errorResponse('course-lectures-schema-not-configured', 503);
  }
  return errorResponse(`${operation}-failed`, 500);
};

const verifyTeacher = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const { data, error } = await supabase.from('teachers')
    .select('id, teacher_name, is_active, password_hash')
    .eq('login_username', clean(username).replace(/\s+/g, '').toLocaleLowerCase())
    .maybeSingle();
  if (error) return { teacher: null, failed: true };
  const teacher = data as TeacherRow | null;
  if (!teacher || !teacher.is_active || !teacher.password_hash) return { teacher: null, failed: false };
  const [salt, storedHash] = teacher.password_hash.split(':');
  if (!salt || !storedHash || !/^[a-f\d]{128}$/i.test(storedHash)) return { teacher: null, failed: false };
  const submittedHash = scryptSync(password, salt, 64);
  if (!timingSafeEqual(submittedHash, Buffer.from(storedHash, 'hex'))) return { teacher: null, failed: false };
  return { teacher, failed: false };
};

const loadAssignments = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  teacherId?: string
) => {
  let query = supabase.from('academic_subjects').select('name, student_year').order('student_year').order('name');
  if (teacherId) query = query.eq('teacher_id', teacherId);
  const { data, error } = await query;
  if (error) return { assignments: null, error };
  const assignments = (data ?? []).flatMap((row) => {
    const name = clean(row.name);
    const year = normalizeStudentYear(row.student_year);
    return name && year ? [{ name, year }] : [];
  });
  return { assignments, error: null };
};

const authenticateStudent = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  studentId: string,
  password: string
) => {
  if (!studentId || !password) return { student: null, error: 'student-credentials-required' };
  const { data, error } = await supabase.from('students').select('*')
    .eq('الرقم الجامعي', studentId).maybeSingle();
  if (error) {
    console.error('COURSE_LECTURE_STUDENT_LOOKUP_FAILED:', error.message);
    return { student: null, error: 'student-verification-failed' };
  }
  if (!data || clean(data['كلمة السر'] ?? data.password ?? data.pass) !== password) {
    return { student: null, error: 'student-credentials-invalid' };
  }
  return { student: data as Record<string, unknown>, error: null };
};

const parseRequest = async (request: Request): Promise<LectureRequest> => {
  if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
    return Object.fromEntries((await request.formData()).entries()) as LectureRequest;
  }
  return await request.json() as LectureRequest;
};

const findAssignment = (assignments: Assignment[], subject: string, year: string) =>
  assignments.find((assignment) => assignment.name === subject && assignment.year === year);

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return errorResponse('course-lectures-server-key-missing', 503);

  try {
    const body = await parseRequest(request);
    const action = clean(body.action);

    if (action.startsWith('student-')) {
      const studentId = clean(body.studentId);
      const authentication = await authenticateStudent(supabase, studentId, clean(body.password));
      if (authentication.error) {
        return errorResponse(authentication.error, authentication.error === 'student-credentials-invalid' ? 401 : 400);
      }

      if (action === 'student-catalog') {
        const { assignments, error } = await loadAssignments(supabase);
        if (error) return databaseFailure('catalog-load', error);
        return NextResponse.json({ success: true, subjects: assignments });
      }

      const lectureId = Number(body.lectureId);
      if (action !== 'student-list' && action !== 'student-download') return errorResponse('invalid-action', 400);
      if (!Number.isSafeInteger(lectureId) && action === 'student-download') return errorResponse('invalid-lecture-id', 400);

      if (action === 'student-download') {
        const { data: lecture, error } = await supabase.from('course_lectures')
          .select('file_path, title, subject')
          .eq('id', lectureId)
          .maybeSingle();
        if (error) return databaseFailure('download-lookup', error);
        if (!lecture) return errorResponse('course-lecture-not-found', 404);
        const downloadName = downloadFileName(String(lecture.subject), String(lecture.title));
        const { data, error: urlError } = await supabase.storage.from(courseLectureBucket)
          .createSignedUrl(String(lecture.file_path), 60);
        if (urlError) {
          console.error('COURSE_LECTURE_SIGNED_URL_FAILED:', urlError.message);
          return errorResponse('course-lecture-download-failed', 500);
        }
        return NextResponse.json({ success: true, url: data.signedUrl, downloadName });
      }

      const subject = clean(body.subject);
      const year = normalizeStudentYear(body.studentYear);
      const { assignments, error: assignmentsError } = await loadAssignments(supabase);
      if (assignmentsError) return databaseFailure('catalog-load', assignmentsError);
      if (!findAssignment(assignments ?? [], subject, year)) return errorResponse('course-subject-not-found', 404);
      const { data: lectures, error } = await supabase.from('course_lectures')
        .select('id, title, subject, student_year, teacher_name, file_name, file_size, created_at')
        .eq('subject', subject)
        .eq('student_year', year)
        .order('created_at', { ascending: false });
      if (error) return databaseFailure('list', error);
      return NextResponse.json({ success: true, lectures: lectures ?? [] });
    }

    let teacher: TeacherRow | null = null;
    let isSupervisor = false;
    if (action.startsWith('supervisor-')) {
      const username = clean(body.supervisorUsername);
      const password = clean(body.supervisorPassword);
      if (!username || !password) return errorResponse('supervisor-credentials-required', 400);
      const verification = await verifyFirstDegreeSupervisor(supabase, username, password);
      if (verification.failed) return errorResponse('supervisor-lookup-failed', 500);
      if (!verification.valid) return errorResponse('supervisor-credentials-invalid', 401);
      isSupervisor = true;
    } else {
      const username = clean(body.username);
      const password = clean(body.password);
      if (!username || !password) return errorResponse('teacher-credentials-required', 400);
      const verification = await verifyTeacher(supabase, username, password);
      if (verification.failed) return errorResponse('teacher-lookup-failed', 500);
      if (!verification.teacher) return errorResponse('teacher-credentials-invalid', 401);
      teacher = verification.teacher;
    }

    const { assignments, error: assignmentsError } = await loadAssignments(
      supabase,
      teacher ? teacher.id : undefined
    );
    if (assignmentsError) return databaseFailure('catalog-load', assignmentsError);
    const allowedAssignments = assignments ?? [];

    if (action === 'teacher-download' || action === 'supervisor-download') {
      const lectureId = Number(body.lectureId);
      if (!Number.isSafeInteger(lectureId) || lectureId <= 0) return errorResponse('invalid-lecture-id', 400);
      let query = supabase.from('course_lectures')
        .select('id, file_path, title, subject, teacher_id')
        .eq('id', lectureId);
      if (teacher) query = query.eq('teacher_id', teacher.id);
      const { data: lecture, error } = await query.maybeSingle();
      if (error) return databaseFailure('download-lookup', error);
      if (!lecture) return errorResponse('course-lecture-not-found', 404);
      const { data, error: urlError } = await supabase.storage.from(courseLectureBucket)
        .createSignedUrl(String(lecture.file_path), 60);
      if (urlError) {
        console.error('COURSE_LECTURE_SIGNED_URL_FAILED:', urlError.message);
        return errorResponse('course-lecture-download-failed', 500);
      }
      return NextResponse.json({
        success: true,
        url: data.signedUrl,
        downloadName: downloadFileName(String(lecture.subject), String(lecture.title)),
      });
    }

    if (action === 'teacher-prepare-upload' || action === 'supervisor-prepare-upload') {
      const subject = clean(body.subject);
      const year = normalizeStudentYear(body.studentYear);
      const title = clean(body.title);
      const fileName = typeof body.fileName === 'string' ? body.fileName : '';
      const fileSize = Number(body.fileSize);
      const fileType = clean(body.fileType).toLowerCase();
      if (!title || title.length > 180 || !findAssignment(allowedAssignments, subject, year)
        || !fileName.toLowerCase().endsWith('.pdf')
        || fileType !== 'application/pdf'
        || !Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > maxCourseLectureFileBytes) {
        return errorResponse('course-lecture-invalid', 400);
      }

      const bucketError = await ensureCourseLectureBucket(supabase);
      if (bucketError) return errorResponse(bucketError, 503);
      const path = randomUUID();
      const { data: upload, error } = await supabase.storage
        .from(courseLectureBucket)
        .createSignedUploadUrl(path, { upsert: false });
      if (error) {
        console.error('COURSE_LECTURE_SIGNED_UPLOAD_CREATE_FAILED:', {
          status: error.status,
          statusCode: error.statusCode,
          message: error.message,
        });
        if (error.statusCode === 'BucketNotFound' || error.status === 404) {
          return errorResponse('lecture-storage-bucket-missing', 503);
        }
        return errorResponse('lecture-upload-authorize-failed', 500);
      }
      return NextResponse.json({
        success: true,
        upload: { signedUrl: upload.signedUrl, path, fileName, fileSize },
      });
    }

    if (action === 'teacher-complete-upload' || action === 'supervisor-complete-upload') {
      const subject = clean(body.subject);
      const year = normalizeStudentYear(body.studentYear);
      const title = clean(body.title);
      const fileName = typeof body.fileName === 'string' ? body.fileName : '';
      const fileSize = Number(body.fileSize);
      const path = clean(body.path);
      const validPath = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(path);
      if (!title || title.length > 180 || !findAssignment(allowedAssignments, subject, year)
        || !validPath || !Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > maxCourseLectureFileBytes) {
        return errorResponse('course-lecture-invalid', 400);
      }

      const { data: fileInfo, error: infoError } = await supabase.storage
        .from(courseLectureBucket)
        .info(path);
      if (infoError || !fileInfo) {
        console.error('COURSE_LECTURE_UPLOAD_VERIFY_FAILED:', infoError?.message ?? 'File metadata not found');
        return errorResponse('lecture-upload-not-found', 400);
      }
      if (Number(fileInfo.size) !== fileSize || fileInfo.contentType !== 'application/pdf') {
        return errorResponse('lecture-upload-verification-failed', 400);
      }

      const { data: lecture, error } = await supabase.from('course_lectures').insert({
        title,
        subject,
        student_year: year,
        teacher_id: teacher?.id ?? null,
        teacher_name: teacher?.teacher_name ?? 'الإدارة',
        file_path: path,
        file_name: fileName,
        file_size: fileSize,
      }).select('id, title, subject, student_year, teacher_name, file_name, file_size, created_at').single();
      if (error) {
        await removeCourseLectureFile(supabase, path);
        return databaseFailure('save', error);
      }
      const notification = await notifyStudentsAboutAnnouncement(supabase, {
        title: lecture.title,
        content: `تم تنزيل محاضرة جديدة لمادة ${lecture.subject} للسنة ${lecture.student_year}.`,
        subject: lecture.subject,
        student_year: lecture.student_year,
        author_type: teacher ? 'teacher' : 'admin',
        author_name: lecture.teacher_name,
        attachment_name: lecture.file_name,
        notification_type: 'lecture',
      });
      return NextResponse.json({ success: true, lecture, notification });
    }

    if (action === 'supervisor-list' || action === 'teacher-list') {
      let query = supabase.from('course_lectures')
        .select('id, title, subject, student_year, teacher_name, file_name, file_size, created_at')
        .order('created_at', { ascending: false });
      if (teacher) query = query.eq('teacher_id', teacher.id);
      const { data, error } = await query;
      if (error) return databaseFailure('list', error);
      return NextResponse.json({ success: true, subjects: allowedAssignments, lectures: data ?? [] });
    }

    if (action === 'supervisor-create' || action === 'teacher-create') {
      const subject = clean(body.subject);
      const year = normalizeStudentYear(body.studentYear);
      const title = clean(body.title);
      const file = body.file instanceof File ? body.file : null;
      if (!title || title.length > 180 || !findAssignment(allowedAssignments, subject, year)) {
        return errorResponse('course-lecture-invalid', 400);
      }
      const upload = await uploadCourseLecture(supabase, file);
      if (upload.error || !upload.attachment) {
        return errorResponse(upload.error ?? 'lecture-pdf-invalid', upload.error === 'lecture-upload-failed' ? 500 : 400);
      }
      const { data: lecture, error } = await supabase.from('course_lectures').insert({
        title,
        subject,
        student_year: year,
        teacher_id: teacher?.id ?? null,
        teacher_name: teacher?.teacher_name ?? 'الإدارة',
        ...upload.attachment,
      }).select('id, title, subject, student_year, teacher_name, file_name, file_size, created_at').single();
      if (error) {
        await removeCourseLectureFile(supabase, upload.attachment.file_path);
        return databaseFailure('save', error);
      }
      const notification = await notifyStudentsAboutAnnouncement(supabase, {
        title: lecture.title,
        content: `تم تنزيل محاضرة جديدة لمادة ${lecture.subject} للسنة ${lecture.student_year}.`,
        subject: lecture.subject,
        student_year: lecture.student_year,
        author_type: teacher ? 'teacher' : 'admin',
        author_name: lecture.teacher_name,
        attachment_name: lecture.file_name,
        notification_type: 'lecture',
      });
      return NextResponse.json({ success: true, lecture, notification });
    }

    if (action === 'supervisor-delete' || action === 'teacher-delete') {
      const lectureId = Number(body.lectureId);
      if (!Number.isSafeInteger(lectureId) || lectureId <= 0) return errorResponse('invalid-lecture-id', 400);
      let query = supabase.from('course_lectures').delete().eq('id', lectureId)
        .select('id, file_path').maybeSingle();
      if (teacher) query = supabase.from('course_lectures').delete().eq('id', lectureId)
        .eq('teacher_id', teacher.id).select('id, file_path').maybeSingle();
      const { data, error } = await query;
      if (error) return databaseFailure('delete', error);
      if (!data) return errorResponse('course-lecture-not-found', 404);
      await removeCourseLectureFile(supabase, String(data.file_path));
      return NextResponse.json({ success: true });
    }

    if (isSupervisor) return errorResponse('invalid-action', 400);
    return errorResponse('invalid-action', 400);
  } catch (error) {
    console.error('COURSE_LECTURES_REQUEST_FAILED:', error);
    return errorResponse('course-lectures-request-failed', 500);
  }
}
