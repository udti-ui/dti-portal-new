import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { writeServerAuditLog } from '../../../../lib/auditLogServer';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';
import { verifyDegreeFourSupervisor, verifyFirstDegreeSupervisor } from '../../../../lib/supervisorAuth';

export const dynamic = 'force-dynamic';

const clean = (value: unknown, maxLength = 500) => String(value ?? '').trim().slice(0, maxLength);
const arabicDigits = (value: string) => value.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
const studentName = (row: Record<string, unknown>) => [
  row['اسم الطالب'],
  row['اسم الاب'] ?? row['اسم الأب'],
  row['الكنية'],
].map((part) => clean(part, 120)).filter(Boolean).join(' ');
const studentYear = (row: Record<string, unknown>) => clean(row['السنه الدراسية'] ?? row['السنة الدراسية']);
const formatStudentId = (value: unknown) => {
  const studentId = arabicDigits(clean(value));
  return /^\d+$/.test(studentId) ? studentId.padStart(4, '0') : studentId;
};
const registrationTypes = ['عام', 'موازي', 'عرب أجانب', 'أبناء مدرسين', 'ذوي احتياجات'];
const departments = ['تعويضات أسنان', 'مساعد طبيب أسنان'];
const normalizePhone = (value: unknown) => arabicDigits(clean(value, 60)).replace(/\s+/g, '').replace(/^0+/, '');
const studentAuditSnapshot = (row: Record<string, unknown>) => ({
  studentId: formatStudentId(row['الرقم الجامعي']),
  studentName: studentName(row),
  phone: normalizePhone(row['رقم الهاتف']),
  email: clean(row['البريد الإلكتروني'], 254),
  department: clean(row['القسم'], 120),
  className: clean(row['الفئة'], 120),
  year: studentYear(row),
  registrationType: clean(row['نوع التسجيل'], 60),
  telegramVerificationCodeProvided: Boolean(clean(row.telegram_verification_code)),
  avatarProvided: Boolean(clean(row.avatar_url)),
});
const auditChanges = (before: Record<string, unknown>, changes: Record<string, string>) =>
  Object.fromEntries(Object.entries(changes).map(([field, value]) => [
    field,
    field === 'telegram_verification_code'
      ? {
        beforeProvided: Boolean(clean(before[field])),
        afterProvided: Boolean(value),
      }
      : {
        before: clean(before[field], 300),
        after: value,
      },
  ]));
const safeRequestedChanges = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([field, item]) => [
    field,
    field === 'telegram_verification_code' ? { valueProvided: Boolean(clean(item)) } : item,
  ]));
};
const availableClassRows = (value: unknown) => Array.isArray(value)
  ? value.filter((row): row is { name: string } => Boolean(
    row
    && typeof row === 'object'
    && 'name' in row
    && typeof row.name === 'string'
  ))
  : [];
const editableFields = new Set([
  'اسم الطالب',
  'اسم الاب',
  'الكنية',
  'رقم الهاتف',
  'البريد الإلكتروني',
  'نوع التسجيل',
  'القسم',
  'الفئة',
  'السنه الدراسية',
  'telegram_verification_code',
]);
const audit = (
  request: Request,
  username: string,
  action: string,
  details: Record<string, unknown>,
  userType: 'supervisor' | 'support_supervisor' = 'support_supervisor'
) => writeServerAuditLog(request, {
  action,
  userType,
  username,
  fullName: username,
  details,
});
const responseError = (error: string, status: number, message?: string) =>
  NextResponse.json({ success: false, error, ...(message ? { message } : {}) }, { status });
const getSupervisorCredentials = (body: Record<string, unknown>) => ({
  username: clean(body.supervisorUsername, 160).replace(/\s+/g, '').toLocaleLowerCase(),
  password: clean(body.supervisorPassword, 300),
});
const toPublicStudent = (row: Record<string, unknown>) => ({
  studentId: formatStudentId(row['الرقم الجامعي']),
  name: studentName(row),
  phone: clean(row['رقم الهاتف']),
  year: studentYear(row),
  createdAt: clean(row.supervisor_created_at ?? row['تاريخ الإنشاء']),
});
const normalizeChanges = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const changes = Object.fromEntries(Object.entries(source)
    .filter(([key]) => editableFields.has(key))
    .map(([key, item]) => [
      key,
      key === 'رقم الهاتف'
        ? normalizePhone(item)
        : clean(item, key === 'telegram_verification_code' ? 100 : 300),
    ]));
  if (!Object.keys(changes).length) return null;
  if (changes['نوع التسجيل'] && !registrationTypes.includes(changes['نوع التسجيل'])) return null;
  if (changes['القسم'] && !departments.includes(changes['القسم'])) return null;
  if (changes['السنه الدراسية'] && !['أولى', 'ثانية'].includes(changes['السنه الدراسية'])) return null;
  if (changes['البريد الإلكتروني'] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes['البريد الإلكتروني'])) return null;
  return changes;
};

export async function POST(request: Request) {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return responseError('invalid-json-body', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return responseError('invalid-request-body', 400);
  }

  const body = parsed as Record<string, unknown>;
  const { username, password } = getSupervisorCredentials(body);
  const action = clean(body.action, 40);
  if (!username || !password) return responseError('supervisor-credentials-required', 400);

  const supabase = createSupabaseAdminClient();
  if (!supabase) return responseError('student-operations-service-not-configured', 503);

  try {
    if (action === 'list-students') {
      const verification = await verifyFirstDegreeSupervisor(supabase, username, password);
      if (verification.failed) return responseError('supervisor-lookup-failed', 503);
      if (!verification.valid) return responseError('first-degree-supervisor-required', 403);

      const requestedPage = Number(body.page);
      const requestedPageSize = Number(body.pageSize);
      const page = Number.isSafeInteger(requestedPage) && requestedPage >= 0 && requestedPage <= 100000 ? requestedPage : 0;
      const pageSize = Number.isSafeInteger(requestedPageSize)
        ? Math.min(Math.max(requestedPageSize, 10), 100)
        : 30;
      const search = clean(body.search, 100).replace(/[,*%()\\"]/g, ' ').trim();
      const className = clean(body.className, 80);
      const year = clean(body.year, 40);
      const section = clean(body.section, 120);
      const start = page * pageSize;
      const filters: string[] = [];

      let query = supabase.from('students')
        .select(
          '"الرقم الجامعي", "اسم الطالب", "اسم الاب", "الكنية", "القسم", "الفئة", "السنه الدراسية", "رقم الهاتف", "البريد الإلكتروني", "نوع التسجيل", "ملاحظة", telegram_chat_id, telegram_notifications_enabled, avatar_url'
        )
        .order('الرقم الجامعي', { ascending: true })
        .range(start, start + pageSize);
      if (search) {
        const pattern = `*${search}*`;
        filters.push(`or(${[
          `"الرقم الجامعي".ilike.${pattern}`,
          `"اسم الطالب".ilike.${pattern}`,
          `"اسم الاب".ilike.${pattern}`,
          `"الكنية".ilike.${pattern}`,
          `"الفئة".ilike.${pattern}`,
          `"القسم".ilike.${pattern}`,
        ].join(',')})`);
      }
      if (className && className !== 'بدون فئة') query = query.eq('الفئة', className);
      if (className === 'بدون فئة') filters.push('or("الفئة".is.null,"الفئة".eq."")');
      if (year) query = query.eq('السنه الدراسية', year);
      if (section) query = query.eq('القسم', section);
      if (filters.length === 1) query = query.or(filters[0].replace(/^or\(|\)$/g, ''));
      if (filters.length > 1) query = query.or(`and(${filters.join(',')})`);

      const { data, error } = await query;
      if (error) {
        console.error('[student-operations] paginated student list failed:', error.message);
        return responseError('student-list-failed', 500);
      }
      const rows = data ?? [];
      return NextResponse.json({
        success: true,
        students: rows.slice(0, pageSize),
        hasMore: rows.length > pageSize,
        page,
        pageSize,
      }, {
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }

    if (action === 'list-tickets' || action === 'review-ticket') {
      const verification = await verifyFirstDegreeSupervisor(supabase, username, password);
      if (verification.failed) return responseError('supervisor-lookup-failed', 503);
      if (!verification.valid) return responseError('first-degree-supervisor-required', 403);

      if (action === 'list-tickets') {
        const { data, error } = await supabase.from('degree4_supervisor_tickets')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(300);
        if (error) {
          console.error('[degree4-students] ticket list failed:', error.message);
          return responseError('ticket-list-failed', 500);
        }
        await audit(request, username, 'degree4_support_tickets_viewed', { count: data?.length ?? 0 }, 'supervisor');
        return NextResponse.json({ success: true, tickets: data ?? [] });
      }

      const ticketId = clean(body.ticketId, 80);
      const decision = clean(body.decision, 20);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ticketId)
        || !['approved', 'rejected'].includes(decision)) {
        return responseError('invalid-ticket-review', 400);
      }
      const { data: reviewedTicket, error: ticketLookupError } = await supabase.from('degree4_supervisor_tickets')
        .select('ticket_type, student_id, requester_username, description, requested_changes')
        .eq('id', ticketId)
        .maybeSingle();
      if (ticketLookupError) {
        console.error('[degree4-students] ticket details lookup failed:', ticketLookupError.message);
        return responseError('ticket-review-details-failed', 500);
      }
      const { data, error } = await supabase.rpc('review_degree4_supervisor_ticket', {
        p_ticket_id: ticketId,
        p_decision: decision,
        p_reviewer: username,
      });
      if (error) {
        const classUnavailable = error.message.includes('ticket_student_class_unavailable');
        const conflict = error.message.includes('ticket_already_reviewed');
        const missing = error.message.includes('ticket_not_found');
        console.error('[degree4-students] ticket review failed:', error.message);
        return responseError(
          missing ? 'ticket-not-found' : conflict ? 'ticket-already-reviewed' : classUnavailable ? 'student-class-unavailable' : 'ticket-review-failed',
          missing ? 404 : conflict || classUnavailable ? 409 : 500
        );
      }
      await audit(request, username, 'degree4_support_ticket_reviewed', {
        ticketId,
        decision,
        ticketType: reviewedTicket?.ticket_type ?? null,
        studentId: reviewedTicket?.student_id ?? null,
        requesterUsername: reviewedTicket?.requester_username ?? null,
        description: clean(reviewedTicket?.description, 3000),
        requestedChanges: safeRequestedChanges(reviewedTicket?.requested_changes),
      }, 'supervisor');
      return NextResponse.json({ success: true, result: data });
    }

    const verification = await verifyDegreeFourSupervisor(supabase, username, password);
    if (verification.failed) return responseError('supervisor-lookup-failed', 503);
    if (!verification.valid) return responseError('degree-four-supervisor-required', 403);

    if (action === 'initial') {
      const { data, error } = await supabase.rpc('suggest_student_university_id');
      if (error) {
        console.error('[degree4-students] student number list failed:', error.message);
        return responseError('student-list-failed', 500);
      }
      const suggestion = clean(data, 40);
      await audit(request, username, 'degree4_student_creation_opened', { suggestedId: suggestion });
      return NextResponse.json({ success: true, suggestedId: suggestion });
    }

    if (action === 'available-classes') {
      const year = clean(body.year, 20);
      if (!['أولى', 'ثانية'].includes(year)) return responseError('invalid-student-year', 400);
      const { data, error } = await supabase.rpc('available_student_classes_for_year', { p_year: year });
      if (error) {
        console.error('[degree4-students] available classes lookup failed:', error.message);
        return responseError('student-classes-load-failed', 500);
      }
      await audit(request, username, 'degree4_available_classes_viewed', {
        year,
        availableCount: availableClassRows(data).length,
      });
      return NextResponse.json({ success: true, classes: data ?? [] });
    }

    if (action === 'select-student') {
      const studentId = clean(body.studentId, 40);
      const { data, error } = await supabase.from('students')
        .select('"الرقم الجامعي", "السنه الدراسية", "الفئة"')
        .eq('الرقم الجامعي', studentId).limit(1);
      if (error) return responseError('student-detail-failed', 500);
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (!row) return responseError('student-not-found', 404);
      await audit(request, username, 'degree4_student_selected', {
        studentId,
        studentName: studentName(row),
      });
      return NextResponse.json({ success: true, year: studentYear(row), className: clean(row['الفئة']) });
    }

    if (action === 'check-id') {
      const studentId = arabicDigits(clean(body.studentId, 40));
      if (!/^\d{4,}$/.test(studentId)) return responseError('invalid-student-id', 400);
      const { data, error } = await supabase.rpc('check_student_university_id', { p_student_id: studentId });
      if (error) return responseError('student-id-check-failed', 500);
      const existing = (data ?? [])[0] as { student_name?: string } | undefined;
      await audit(request, username, 'degree4_student_id_checked', {
        studentId,
        exists: Boolean(existing),
        existingName: existing?.student_name ?? null,
      });
      return NextResponse.json({
        success: true,
        exists: Boolean(existing),
        existingName: existing?.student_name ?? null,
      });
    }

    if (action === 'my-accounts') {
      const { data, error } = await supabase.from('students')
        .select('"الرقم الجامعي", "اسم الطالب", "اسم الاب", "الكنية", "رقم الهاتف", "السنه الدراسية", supervisor_created_at')
        .eq('created_by_supervisor', username)
        .order('supervisor_created_at', { ascending: false })
        .range(0, 999);
      if (error) return responseError('created-student-list-failed', 500);
      const accounts = (data ?? []).map((row) => {
        const record = row as Record<string, unknown>;
        const createdAt = Date.parse(clean(record.supervisor_created_at));
        const age = Date.now() - createdAt;
        return {
          ...toPublicStudent(record),
          canDelete: Number.isFinite(createdAt) && age >= 0 && age <= 24 * 60 * 60 * 1000,
          canEdit: Number.isFinite(createdAt) && age >= 0 && age <= 48 * 60 * 60 * 1000,
        };
      });
      await audit(request, username, 'degree4_created_accounts_viewed', { count: accounts.length });
      return NextResponse.json({ success: true, accounts });
    }

    if (action === 'search') {
      const term = clean(body.query, 120);
      if (term.length < 2) return responseError('search-term-too-short', 400);
      await audit(request, username, 'degree4_student_search', { query: term });
      const { data, error } = await supabase.rpc('search_students_for_degree4', { p_query: term });
      if (error) return responseError('student-search-failed', 500);
      return NextResponse.json({
        success: true,
        students: ((data ?? []) as Array<{
          student_id: unknown;
          student_name: unknown;
          phone: unknown;
        }>).map((row) => ({
          studentId: formatStudentId(row.student_id),
          name: clean(row.student_name),
          phone: clean(row.phone),
        })),
      });
    }

    if (action === 'get-owned-account') {
      const studentId = clean(body.studentId, 40);
      const { data, error } = await supabase.from('students')
        .select('"الرقم الجامعي", "اسم الطالب", "اسم الاب", "الكنية", "رقم الهاتف", "البريد الإلكتروني", "نوع التسجيل", "telegram_verification_code", "القسم", "الفئة", "السنه الدراسية", supervisor_created_at')
        .eq('الرقم الجامعي', studentId)
        .eq('created_by_supervisor', username)
        .limit(1);
      if (error) return responseError('student-detail-failed', 500);
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (!row) return responseError('created-student-not-found', 404);
      const createdAt = Date.parse(clean(row.supervisor_created_at));
      const canEdit = Number.isFinite(createdAt) && Date.now() - createdAt >= 0 && Date.now() - createdAt <= 48 * 60 * 60 * 1000;
      if (!canEdit) return responseError('student-edit-window-expired', 403);
      await audit(request, username, 'degree4_created_student_opened', { studentId });
      return NextResponse.json({
        success: true,
        student: {
          studentId,
          name: studentName(row),
          phone: clean(row['رقم الهاتف']),
          email: clean(row['البريد الإلكتروني']),
          registrationType: clean(row['نوع التسجيل']),
          telegramCode: clean(row.telegram_verification_code),
          fields: {
            'اسم الطالب': clean(row['اسم الطالب']),
            'اسم الاب': clean(row['اسم الاب'] ?? row['اسم الأب']),
            'الكنية': clean(row['الكنية']),
            'رقم الهاتف': clean(row['رقم الهاتف']),
            'البريد الإلكتروني': clean(row['البريد الإلكتروني']),
            'نوع التسجيل': clean(row['نوع التسجيل']),
            'القسم': clean(row['القسم']),
            'الفئة': clean(row['الفئة']),
            'السنه الدراسية': studentYear(row),
            telegram_verification_code: clean(row.telegram_verification_code),
          },
          createdAt: clean(row.supervisor_created_at),
        },
      });
    }

    if (action === 'create') {
      if (!body.student || typeof body.student !== 'object' || Array.isArray(body.student)) {
        return responseError('invalid-student-account', 400);
      }
      const input = body.student as Record<string, unknown>;
      const studentId = arabicDigits(clean(input['الرقم الجامعي'], 40));
      const year = clean(input['السنه الدراسية'], 20);
      const registrationType = clean(input['نوع التسجيل'], 60);
      const department = clean(input['القسم'], 120);
      const passwordValue = clean(input['كلمة السر'], 300);
      const required = ['اسم الطالب', 'اسم الاب', 'الكنية', 'رقم الهاتف', 'البريد الإلكتروني', 'القسم'];
      if (!/^\d{4,}$/.test(studentId) || !['أولى', 'ثانية'].includes(year)
        || !registrationTypes.includes(registrationType) || !departments.includes(department) || !passwordValue
        || required.some((field) => !clean(input[field], 300))) {
        return responseError('required-student-fields-missing', 400);
      }
      const className = clean(input['الفئة'], 120);
      if (className) {
        const { data: availableClasses, error: classesError } = await supabase.rpc('available_student_classes_for_year', { p_year: year });
        if (classesError) return responseError('student-classes-load-failed', 500);
        if (!availableClassRows(availableClasses).some((item) => item.name === className)) {
          return responseError('student-class-unavailable', 409);
        }
      }
      const email = clean(input['البريد الإلكتروني'], 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return responseError('invalid-student-email', 400);
      const { data: duplicates, error: duplicateError } = await supabase.rpc('check_student_university_id', { p_student_id: studentId });
      if (duplicateError) return responseError('student-id-check-failed', 500);
      if (duplicates?.length) {
        return NextResponse.json({
          success: false,
          error: 'student-id-already-exists',
          existingName: (duplicates[0] as { student_name?: string }).student_name ?? null,
        }, { status: 409 });
      }

      const student: Record<string, unknown> = {
        'الرقم الجامعي': studentId,
        'كلمة السر': passwordValue,
        'اسم الطالب': clean(input['اسم الطالب'], 120),
        'اسم الاب': clean(input['اسم الاب'], 120),
        'الكنية': clean(input['الكنية'], 120),
        'القسم': department,
        'الفئة': className,
        'السنه الدراسية': year,
        'رقم الهاتف': normalizePhone(input['رقم الهاتف']),
        'البريد الإلكتروني': email,
        'نوع التسجيل': registrationType,
        telegram_verification_code: clean(input.telegram_verification_code, 100) || null,
        created_by_supervisor: username,
        supervisor_created_at: new Date().toISOString(),
        force_password_change: year === 'أولى',
      };
      if (!student['رقم الهاتف']) return responseError('invalid-student-phone', 400);

      let avatarPath = '';
      if (body.avatar !== undefined && body.avatar !== null && body.avatar !== '') {
        const avatar = clean(body.avatar, 3_000_000);
        const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(avatar);
        if (!match) return responseError('invalid-student-avatar', 400);
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > 2 * 1024 * 1024) return responseError('student-avatar-too-large', 413);
        const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
        avatarPath = `${studentId}/${randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage.from('avatars').upload(avatarPath, bytes, {
          contentType: `image/${match[1]}`,
          cacheControl: '3600',
          upsert: false,
        });
        if (uploadError) {
          console.error('[degree4-students] avatar upload failed:', uploadError.message);
          return responseError('student-avatar-upload-failed', 500);
        }
        student.avatar_url = supabase.storage.from('avatars').getPublicUrl(avatarPath).data.publicUrl;
      }

      const { error } = await supabase.from('students').insert([student]);
      if (error) {
        if (avatarPath) await supabase.storage.from('avatars').remove([avatarPath]);
        if (error.code === '23505') {
          const { data: existing } = await supabase.rpc('check_student_university_id', { p_student_id: studentId });
          return NextResponse.json({
            success: false,
            error: 'student-id-already-exists',
            existingName: (existing?.[0] as { student_name?: string } | undefined)?.student_name ?? null,
          }, { status: 409 });
        }
        console.error('[degree4-students] account creation failed:', error.message);
        return responseError('student-account-save-failed', 500);
      }
      await audit(request, username, 'student_created_by_degree4_supervisor', {
        ...studentAuditSnapshot(student),
        initialPasswordSet: true,
      });
      return NextResponse.json({ success: true, studentId, forcePasswordChange: year === 'أولى' });
    }

    if (action === 'delete') {
      const studentId = clean(body.studentId, 40);
      const { data, error } = await supabase.from('students')
        .select('"الرقم الجامعي", "اسم الطالب", "اسم الاب", "الكنية", "رقم الهاتف", "البريد الإلكتروني", "القسم", "الفئة", "السنه الدراسية", "نوع التسجيل", telegram_verification_code, avatar_url, supervisor_created_at')
        .eq('الرقم الجامعي', studentId)
        .eq('created_by_supervisor', username)
        .limit(1);
      if (error) return responseError('student-detail-failed', 500);
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (!row) return responseError('created-student-not-found', 404);
      const createdAt = Date.parse(clean(row.supervisor_created_at));
      if (!Number.isFinite(createdAt) || Date.now() - createdAt < 0 || Date.now() - createdAt > 24 * 60 * 60 * 1000) {
        return responseError('student-delete-window-expired', 403);
      }
      const { error: deleteError } = await supabase.from('students').delete()
        .eq('الرقم الجامعي', studentId)
        .eq('created_by_supervisor', username);
      if (deleteError) return responseError('student-delete-failed', 500);
      await audit(request, username, 'degree4_created_student_deleted', {
        ...studentAuditSnapshot(row),
        createdAt: clean(row.supervisor_created_at),
        deletedAt: new Date().toISOString(),
      });
      return NextResponse.json({ success: true });
    }

    if (action === 'edit') {
      const studentId = clean(body.studentId, 40);
      const changes = normalizeChanges(body.changes);
      if (!changes) return responseError('invalid-student-changes', 400);
      const { data, error } = await supabase.from('students')
        .select('"الرقم الجامعي", "اسم الطالب", "اسم الاب", "الكنية", "رقم الهاتف", "البريد الإلكتروني", "القسم", "الفئة", "السنه الدراسية", "نوع التسجيل", telegram_verification_code, avatar_url, supervisor_created_at')
        .eq('الرقم الجامعي', studentId)
        .eq('created_by_supervisor', username)
        .limit(1);
      if (error) return responseError('student-detail-failed', 500);
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (!row) return responseError('created-student-not-found', 404);
      const createdAt = Date.parse(clean(row.supervisor_created_at));
      if (!Number.isFinite(createdAt) || Date.now() - createdAt < 0 || Date.now() - createdAt > 48 * 60 * 60 * 1000) {
        return responseError('student-edit-window-expired', 403);
      }
      const updatePayload: Record<string, unknown> = { ...changes };
      if (changes['الفئة']) {
        const year = changes['السنه الدراسية'] ?? studentYear(row);
        const { data: availableClasses, error: classesError } = await supabase.rpc('available_student_classes_for_year', { p_year: year });
        if (classesError) return responseError('student-classes-load-failed', 500);
        if (!availableClassRows(availableClasses).some((item) => item.name === changes['الفئة'])) {
          return responseError('student-class-unavailable', 409);
        }
      }
      if (changes['السنه الدراسية'] === 'أولى') updatePayload.force_password_change = true;
      const { error: updateError } = await supabase.from('students').update(updatePayload).eq('الرقم الجامعي', studentId);
      if (updateError) return responseError('student-update-failed', 500);
      await audit(request, username, 'student_updated_by_degree4_supervisor', {
        ...studentAuditSnapshot(row),
        changedFields: Object.keys(changes),
        changes: auditChanges(row, changes),
      });
      return NextResponse.json({ success: true });
    }

    if (action === 'request-update') {
      const studentId = clean(body.studentId, 40);
      const description = clean(body.description, 3000);
      const changes = normalizeChanges(body.changes);
      if (!studentId || description.length < 3 || !changes) return responseError('invalid-student-update-request', 400);
      const { data: found, error: studentError } = await supabase.from('students')
        .select('"الرقم الجامعي", "اسم الطالب", "اسم الاب", "الكنية", "رقم الهاتف", "البريد الإلكتروني", "القسم", "الفئة", "السنه الدراسية", "نوع التسجيل", telegram_verification_code, avatar_url')
        .eq('الرقم الجامعي', studentId).limit(1);
      if (studentError) return responseError('student-detail-failed', 500);
      const row = (found ?? [])[0] as Record<string, unknown> | undefined;
      if (!row) return responseError('student-not-found', 404);
      if (changes['الفئة']) {
        const year = changes['السنه الدراسية'] ?? studentYear(row);
        const { data: availableClasses, error: classesError } = await supabase.rpc('available_student_classes_for_year', { p_year: year });
        if (classesError) return responseError('student-classes-load-failed', 500);
        if (!availableClassRows(availableClasses).some((item) => item.name === changes['الفئة'])) {
          return responseError('student-class-unavailable', 409);
        }
      }
      const { data: ticket, error } = await supabase.from('degree4_supervisor_tickets').insert([{
        ticket_type: 'student_update',
        student_id: studentId,
        requester_username: username,
        description,
        requested_changes: changes,
      }]).select('id').single();
      if (error) return responseError('ticket-create-failed', 500);
      await audit(request, username, 'degree4_student_update_requested', {
        ticketId: ticket.id,
        studentId,
        studentName: studentName(row),
        student: studentAuditSnapshot(row),
        requestedFields: Object.keys(changes),
        requestedChanges: safeRequestedChanges(changes),
        description,
      });
      return NextResponse.json({ success: true, ticketId: ticket.id });
    }

    if (action === 'create-ticket') {
      const description = clean(body.description, 3000);
      if (description.length < 3) return responseError('invalid-ticket-description', 400);
      const { data: ticket, error } = await supabase.from('degree4_supervisor_tickets').insert([{
        ticket_type: 'general',
        requester_username: username,
        description,
      }]).select('id').single();
      if (error) return responseError('ticket-create-failed', 500);
      await audit(request, username, 'degree4_support_ticket_created', { ticketId: ticket.id });
      return NextResponse.json({ success: true, ticketId: ticket.id });
    }

    return responseError('invalid-action', 400);
  } catch (error) {
    console.error('[degree4-students] request failed:', error);
    return responseError('student-operations-failed', 500);
  }
}
