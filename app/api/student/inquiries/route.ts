import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';
import { normalizeStudentYear } from '../../../../lib/studentData';
import { sendTelegramNotification } from '../../../../lib/telegram';
import { getInquiryMessages } from '../../../../lib/teacherInquiryMessages';
import { removeAnnouncementAttachment, uploadAnnouncementAttachment } from '../../../../lib/announcementAttachments';

export const dynamic = 'force-dynamic';

type InquiryRequest = {
  action?: string;
  studentId?: string;
  password?: string;
  studentYear?: string;
  subject?: string;
  message?: string;
  attachment?: File;
};

const clean = (value: unknown) => String(value ?? '').trim();
const subjectKey = (value: unknown) => clean(value).replace(/\s+/g, ' ').toLocaleLowerCase();
const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');
const errorResponse = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });
const getStudentName = (student: Record<string, unknown>) => [
  student['اسم الطالب'] ?? student.name ?? student.student_name,
  student['اسم الاب'] ?? student['اسم الأب'] ?? student.father_name,
  student['الكنية'] ?? student.family_name ?? student.surname,
].map(clean).filter(Boolean).join(' ') || 'الطالب';

const parseRequest = async (request: Request): Promise<InquiryRequest> => {
  if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
    const formData = await request.formData();
    return {
      action: clean(formData.get('action')),
      studentId: clean(formData.get('studentId')),
      password: String(formData.get('password') ?? ''),
      studentYear: clean(formData.get('studentYear')),
      subject: clean(formData.get('subject')),
      message: String(formData.get('message') ?? ''),
      attachment: formData.get('attachment') instanceof File ? formData.get('attachment') as File : undefined,
    };
  }
  return await request.json() as InquiryRequest;
};

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return errorResponse('student-portal-server-key-missing', 503);

  let uploadedPath: string | null = null;
  try {
    const body = await parseRequest(request);
    const studentId = clean(body.studentId);
    const password = String(body.password ?? '');
    if (!studentId || !password) return errorResponse('student-credentials-required', 400);

    const { data: student, error: studentError } = await supabase.from('students')
      .select('"كلمة السر", "اسم الطالب", "اسم الاب", "الكنية", "الفئة"')
      .eq('الرقم الجامعي', studentId).maybeSingle();
    if (studentError) return errorResponse('student-lookup-failed', 500);
    if (!student || clean(student['كلمة السر']) !== password) {
      return errorResponse('student-credentials-invalid', 401);
    }

    const studentRecord = student as Record<string, unknown>;
    const { data: subjectRows, error: subjectsError } = await supabase.from('academic_subjects')
      .select('name, student_year, teacher_id')
      .order('name');
    if (subjectsError) return errorResponse('inquiry-subjects-load-failed', 500);

    const subjectTeachers = new Map<string, Set<string>>();
    for (const row of subjectRows ?? []) {
      const year = normalizeStudentYear(row.student_year);
      const nameKey = subjectKey(row.name);
      if (!year || !nameKey) continue;
      const key = `${year}|${nameKey}`;
      const teacherIds = subjectTeachers.get(key) ?? new Set<string>();
      teacherIds.add(String(row.teacher_id));
      subjectTeachers.set(key, teacherIds);
    }
    const teacherIds = [...new Set([...subjectTeachers.values()].flatMap((ids) => [...ids]))];
    const { data: teachers, error: teachersError } = teacherIds.length
      ? await supabase.from('teachers').select('id, teacher_name, telegram_chat_id').eq('is_active', true).in('id', teacherIds)
      : { data: [], error: null };
    if (teachersError) return errorResponse('inquiry-teachers-load-failed', 500);
    const activeTeacherIds = new Set((teachers ?? []).map((teacher) => String(teacher.id)));

    if (body.action === 'list') {
      const subjects = [...subjectTeachers.entries()].flatMap(([key, ids]) => {
        const assignedTeachers = (teachers ?? []).filter((teacher) => ids.has(String(teacher.id)));
        const [year, nameKey] = key.split('|', 2);
        return assignedTeachers.length ? [{
          year,
          name: clean(subjectRows?.find((row) =>
            normalizeStudentYear(row.student_year) === year && subjectKey(row.name) === nameKey
          )?.name),
          teachers: assignedTeachers.map((teacher) => clean(teacher.teacher_name)),
        }] : [];
      });
      const { data: inquiries, error: inquiriesError } = await supabase.from('teacher_inquiries')
        .select('id, subject, student_year, status, created_at, updated_at')
        .eq('student_id', studentId)
        .order('updated_at', { ascending: false });
      if (inquiriesError) {
        console.error('STUDENT_INQUIRIES_LOAD_FAILED:', inquiriesError.message);
        return errorResponse('student-inquiries-load-failed', 500);
      }
      const inquiryIds = (inquiries ?? []).map((inquiry) => String(inquiry.id));
      const messages = await getInquiryMessages(supabase, inquiryIds);
      return NextResponse.json({
        success: true,
        subjects,
        inquiries: (inquiries ?? []).map((inquiry) => ({
          ...inquiry,
          id: String(inquiry.id),
          messages: messages.filter((message) => message.inquiry_id === String(inquiry.id)),
        })),
      });
    }

    if (body.action !== 'create') return errorResponse('invalid-action', 400);
    const subject = clean(body.subject);
    const selectedYear = normalizeStudentYear(body.studentYear);
    const message = clean(body.message);
    if (!selectedYear || !subject || message.length < 3 || message.length > 4000) {
      return errorResponse('invalid-inquiry', 400);
    }
    const assignedIds = subjectTeachers.get(`${selectedYear}|${subjectKey(subject)}`);
    if (!assignedIds) return errorResponse('inquiry-subject-not-assigned', 403);
    const recipients = [...assignedIds].filter((id) => activeTeacherIds.has(id));
    if (!recipients.length) return errorResponse('inquiry-no-active-teachers', 409);

    const upload = await uploadAnnouncementAttachment(supabase, body.attachment ?? null);
    if (upload.error) {
      return errorResponse(upload.error === 'announcement-attachment-invalid'
        ? 'inquiry-attachment-invalid'
        : 'inquiry-attachment-save-failed', upload.error === 'announcement-attachment-invalid' ? 400 : 500);
    }
    uploadedPath = upload.attachment?.attachment_path ?? null;

    const studentName = getStudentName(studentRecord);
    const { data: inquiry, error: inquiryError } = await supabase.from('teacher_inquiries').insert({
      student_id: studentId,
      student_name: studentName,
      student_year: selectedYear,
      student_class: clean(studentRecord['الفئة'] ?? studentRecord.class ?? studentRecord.class_name),
      subject,
      status: 'awaiting_teacher',
    }).select('id').single();
    if (inquiryError || !inquiry) {
      if (uploadedPath) await removeAnnouncementAttachment(supabase, uploadedPath);
      console.error('STUDENT_INQUIRY_CREATE_FAILED:', inquiryError?.message ?? 'Inquiry row missing');
      return errorResponse('student-inquiry-save-failed', 500);
    }

    const inquiryId = String(inquiry.id);
    const { error: recipientsError } = await supabase.from('teacher_inquiry_recipients')
      .insert(recipients.map((teacherId) => ({ inquiry_id: inquiryId, teacher_id: teacherId })));
    if (recipientsError) {
      await supabase.from('teacher_inquiries').delete().eq('id', inquiryId);
      if (uploadedPath) await removeAnnouncementAttachment(supabase, uploadedPath);
      console.error('STUDENT_INQUIRY_RECIPIENTS_SAVE_FAILED:', recipientsError.message);
      return errorResponse('student-inquiry-save-failed', 500);
    }

    const attachment = upload.attachment;
    const { error: messageError } = await supabase.from('teacher_inquiry_messages').insert({
      inquiry_id: inquiryId,
      sender_type: 'student',
      sender_id: studentId,
      sender_name: studentName,
      body: message,
      ...(attachment ?? {}),
    });
    if (messageError) {
      await supabase.from('teacher_inquiries').delete().eq('id', inquiryId);
      if (uploadedPath) await removeAnnouncementAttachment(supabase, uploadedPath);
      console.error('STUDENT_INQUIRY_MESSAGE_SAVE_FAILED:', messageError.message);
      return errorResponse('student-inquiry-save-failed', 500);
    }

    const notificationTargets = (teachers ?? [])
      .filter((teacher) => recipients.includes(String(teacher.id)) && clean(teacher.telegram_chat_id));
    const notifications = await Promise.all(notificationTargets
      .map(async (teacher) => {
        const result = await sendTelegramNotification([
          '📩 <b>لديك استفسار جديد من طالب</b>',
          '━━━━━━━━━━━━━━━━━━',
          `👤 <b>الطالب:</b> ${escapeHtml(studentName)}`,
          `📖 <b>المادة:</b> ${escapeHtml(subject)}`,
          `📝 <b>الاستفسار:</b> ${escapeHtml(message.slice(0, 900))}`,
          ...(attachment ? [`📎 <b>مرفق:</b> ${escapeHtml(attachment.attachment_name)}`] : []),
        ].join('\n'), { chatId: clean(teacher.telegram_chat_id), enabled: true });
        if (result?.ok !== true) {
          console.error('TEACHER_INQUIRY_TELEGRAM_FAILED:', { teacherId: teacher.id, status: result?.status });
          return false;
        }
        return true;
      }));

    return NextResponse.json({
      success: true,
      inquiryId,
      notificationsSent: notifications.filter(Boolean).length,
      notificationTargets: notificationTargets.length,
    });
  } catch (error) {
    if (uploadedPath) {
      const supabase = createSupabaseAdminClient();
      if (supabase) await removeAnnouncementAttachment(supabase, uploadedPath);
    }
    console.error('STUDENT_INQUIRY_REQUEST_FAILED:', error);
    return errorResponse(error instanceof Error && error.message === 'inquiry-attachment-link-failed'
      ? 'inquiry-attachment-link-failed'
      : 'student-inquiry-request-failed', 500);
  }
}
