import { NextResponse } from 'next/server';
import { normalizeStudentYear } from '../../../lib/studentData';
import { createSupabaseAdminClient } from '../../../lib/supabaseAdmin';
import { notifyStudentsAboutAnnouncement } from '../../../lib/announcementNotifications';
import { verifyFirstDegreeSupervisor } from '../../../lib/supervisorAuth';
import { removeAnnouncementAttachment, uploadAnnouncementAttachment } from '../../../lib/announcementAttachments';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => String(value ?? '').trim();
const errorResponse = (error: string, status: number) =>
  NextResponse.json({ success: false, error }, { status });
const databaseFailure = (error: { code?: string; message?: string }) => {
  const message = String(error.message ?? '');
  if (error.code === 'PGRST205' || /does not exist|relation|not found/i.test(message)) {
    return errorResponse('announcement-schema-not-configured', 503);
  }
  console.error('ANNOUNCEMENTS_DATABASE_REQUEST_FAILED:', { code: error.code, message });
  return errorResponse('announcements-load-failed', 500);
};

const authenticateStudent = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  studentId: string,
  password: string
) => {
  const { data: student, error } = await supabase.from('students').select('"كلمة السر", "السنه الدراسية"')
    .eq('الرقم الجامعي', studentId).maybeSingle();
  if (error) {
    console.error('ANNOUNCEMENT_STUDENT_LOOKUP_FAILED:', error.message);
    return { student: null, error: 'announcements-load-failed' as const };
  }
  if (!student || clean(student['كلمة السر']) !== password) {
    return { student: null, error: 'student-credentials-invalid' as const };
  }
  return { student: student as Record<string, unknown>, error: null };
};

const studentYear = (student: Record<string, unknown>) => normalizeStudentYear(
  student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year
);

const validAnnouncementText = (title: string, content: string) =>
  title.length >= 3 && title.length <= 160 && content.length <= 4000;

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return errorResponse('announcement-server-key-missing', 503);

  try {
    let body: Record<string, unknown>;
    try {
      const contentType = request.headers.get('content-type') ?? '';
      let parsed: unknown;
      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        parsed = Object.fromEntries(formData.entries());
      } else {
        parsed = await request.json() as unknown;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return errorResponse('invalid-request-body', 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return errorResponse('invalid-json-body', 400);
    }

    const action = clean(body.action);
    if (action === 'student-list' || action === 'mark-read' || action === 'attachment-url') {
      const id = clean(body.studentId);
      const password = clean(body.password);
      if (!id || !password) return errorResponse('student-credentials-required', 400);
      const authenticated = await authenticateStudent(supabase, id, password);
      if (authenticated.error) return errorResponse(authenticated.error, authenticated.error === 'student-credentials-invalid' ? 401 : 500);
      const year = studentYear(authenticated.student!);
      if (!year) return errorResponse('invalid-student-year', 400);

      if (action === 'student-list') {
        const { data: announcements, error } = await supabase.from('announcements')
          .select('id, title, content, subject, student_year, target_scope, author_type, author_name, created_at, attachment_name, attachment_type, attachment_size')
          .or(`student_year.eq.${year},target_scope.eq.all`)
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) return databaseFailure(error);
        const rows = announcements ?? [];
        if (!rows.length) return NextResponse.json({ success: true, announcements: [] });
        const { data: reads, error: readsError } = await supabase.from('announcement_reads')
          .select('announcement_id')
          .eq('student_id', id)
          .in('announcement_id', rows.map((announcement) => announcement.id));
        if (readsError) return databaseFailure(readsError);
        const readIds = new Set((reads ?? []).map((read) => Number(read.announcement_id)));
        return NextResponse.json({
          success: true,
          announcements: rows.map((announcement) => ({
            ...announcement,
            is_read: readIds.has(Number(announcement.id)),
          })),
        });
      }

      const announcementId = Number(body.announcementId);
      if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
        return errorResponse('invalid-announcement-id', 400);
      }
      if (action === 'attachment-url') {
        const { data: announcement, error } = await supabase.from('announcements')
          .select('attachment_path')
          .eq('id', announcementId)
          .or(`student_year.eq.${year},target_scope.eq.all`)
          .maybeSingle();
        if (error) return databaseFailure(error);
        if (!announcement?.attachment_path) return errorResponse('announcement-not-found', 404);
        const { data, error: signedUrlError } = await supabase.storage.from('announcements')
          .createSignedUrl(String(announcement.attachment_path), 60 * 10);
        if (signedUrlError) {
          console.error('ANNOUNCEMENT_ATTACHMENT_SIGNED_URL_FAILED:', signedUrlError.message);
          return errorResponse('announcement-attachment-load-failed', 500);
        }
        return NextResponse.json({ success: true, url: data.signedUrl });
      }

      const { data: announcement, error: announcementError } = await supabase.from('announcements')
        .select('id')
        .eq('id', announcementId)
        .or(`student_year.eq.${year},target_scope.eq.all`)
        .maybeSingle();
      if (announcementError) return databaseFailure(announcementError);
      if (!announcement) return errorResponse('announcement-not-found', 404);
      const { error: readError } = await supabase.from('announcement_reads').upsert({
        announcement_id: announcementId,
        student_id: id,
        read_at: new Date().toISOString(),
      }, { onConflict: 'announcement_id,student_id' });
      if (readError) return databaseFailure(readError);
      return NextResponse.json({ success: true });
    }

    const supervisorUsername = clean(body.supervisorUsername);
    const supervisorPassword = clean(body.supervisorPassword);
    if (!supervisorUsername || !supervisorPassword) return errorResponse('supervisor-credentials-required', 400);
    const verification = await verifyFirstDegreeSupervisor(supabase, supervisorUsername, supervisorPassword);
    if (verification.failed) return errorResponse('supervisor-lookup-failed', 500);
    if (!verification.valid) return errorResponse('supervisor-credentials-invalid', 401);

    if (action === 'supervisor-data') {
      const { data: announcements, error: announcementsError } = await supabase.from('announcements')
        .select('id, title, content, subject, student_year, target_scope, author_type, author_name, created_at, attachment_name, attachment_type, attachment_size')
        .order('created_at', { ascending: false }).limit(200);
      if (announcementsError) return databaseFailure(announcementsError);
      return NextResponse.json({
        success: true,
        announcements: announcements ?? [],
      });
    }

    if (action === 'supervisor-delete') {
      const announcementId = Number(body.announcementId);
      if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
        return errorResponse('invalid-announcement-id', 400);
      }
      const { data: announcement, error } = await supabase.from('announcements')
        .delete()
        .eq('id', announcementId)
        .select('id, attachment_path')
        .maybeSingle();
      if (error) return databaseFailure(error);
      if (!announcement) return errorResponse('announcement-not-found', 404);
      if (announcement.attachment_path) {
        await removeAnnouncementAttachment(supabase, String(announcement.attachment_path));
      }
      return NextResponse.json({ success: true });
    }

    if (action === 'create-supervisor') {
      const year = normalizeStudentYear(body.studentYear);
      const targetScope = clean(body.targetScope);
      const title = clean(body.title);
      const content = clean(body.content);
      const allYears = targetScope === 'all';
      const attachment = body.attachment instanceof File ? body.attachment : null;
      if (!['year', 'all'].includes(targetScope)
        || (!allYears && !year)
        || !validAnnouncementText(title, content)
        || (!content && !attachment)) {
        return errorResponse('invalid-announcement', 400);
      }
      if (content.length > 0 && content.length < 3 && !attachment) return errorResponse('invalid-announcement', 400);
      const upload = await uploadAnnouncementAttachment(supabase, attachment);
      if (upload.error || !validAnnouncementText(title, content) || (!content && !upload.attachment)) {
        const status = upload.error === 'announcement-attachment-save-failed' ? 500 : 400;
        return errorResponse(upload.error ?? 'invalid-announcement', status);
      }
      const { data: announcement, error } = await supabase.from('announcements').insert({
        title,
        content,
        subject: null,
        student_year: allYears ? null : year,
        target_scope: allYears ? 'all' : 'year',
        author_type: 'admin',
        author_name: 'الإدارة',
        ...upload.attachment,
      }).select('id, title, content, subject, student_year, target_scope, author_type, author_name, created_at, attachment_name, attachment_type, attachment_size').single();
      if (error) {
        if (upload.attachment) await removeAnnouncementAttachment(supabase, upload.attachment.attachment_path);
        return databaseFailure(error);
      }
      const notification = await notifyStudentsAboutAnnouncement(supabase, announcement);
      return NextResponse.json({ success: true, announcement, notification });
    }

    return errorResponse('invalid-action', 400);
  } catch (error) {
    console.error('ANNOUNCEMENTS_REQUEST_FAILED:', error);
    return errorResponse('announcements-request-failed', 500);
  }
}
