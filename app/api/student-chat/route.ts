import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../lib/supabaseAdmin';
import { normalizeStudentYear } from '../../../lib/studentData';
import { verifyFirstDegreeSupervisor, verifySupervisorCredentials } from '../../../lib/supervisorAuth';
import { writeServerAuditLog } from '../../../lib/auditLogServer';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => String(value ?? '').trim();
const retentionMs = 48 * 60 * 60 * 1000;
const messageEditWindowMs = 15 * 60 * 1000;
const maxAttachmentBytes = 1024 * 1024;
const attachmentTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const arabicDiacritics = /[\u064B-\u065F\u0670\u0640]/g;
const prohibitedWords = new Set([
  'شرموط', 'شرموطه', 'كس', 'كسم', 'كوس', 'طيز', 'عرص', 'قحبه', 'منيوك',
  'متناك', 'خول', 'عاهر', 'زاني', 'قواد', 'fuck', 'fucking', 'shit', 'bitch',
  'asshole', 'bastard', 'cunt', 'motherfucker', 'slut', 'whore',
]);

const normalizeWord = (value: string) => value
  .toLocaleLowerCase()
  .replace(arabicDiacritics, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[ؤئ]/g, (letter) => letter === 'ؤ' ? 'و' : 'ي');

const containsProhibitedLanguage = (message: string) => {
  const words = message.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.some((word) => prohibitedWords.has(normalizeWord(word)))) return true;
  const compact = normalizeWord(message).replace(/[^\p{L}\p{N}]/gu, '');
  return [...prohibitedWords].some((word) => word.length > 3 && compact.includes(word));
};

const errorResponse = (error: string, status: number) =>
  NextResponse.json({ success: false, error }, { status });

const isValidAttachment = (type: string, bytes: Uint8Array) => {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10';
  if (type === 'image/gif') return new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
  if (type === 'image/webp') return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
    && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  if (type === 'application/pdf') return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
  if (type === 'text/plain') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
    } catch {
      return false;
    }
  }
  return false;
};

const safeFileName = (name: string) => name
  .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
  .trim()
  .slice(0, 160) || 'attachment';

const getAttachmentType = (file: File) => {
  const type = file.type.toLocaleLowerCase();
  if (type === 'image/jpg') return 'image/jpeg';
  if (attachmentTypes.has(type)) return type;
  const extension = file.name.toLocaleLowerCase().split('.').pop();
  const extensionTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
  };
  return extensionTypes[extension ?? ''] ?? '';
};

const authenticateStudent = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  studentId: string,
  password: string
) => {
  const { data, error } = await supabase.from('students').select('*')
    .eq('الرقم الجامعي', studentId).maybeSingle();
  if (error) {
    console.error('STUDENT_CHAT_STUDENT_LOOKUP_FAILED:', error.message);
    return { student: null, failed: true };
  }
  const student = data as Record<string, unknown> | null;
  if (!student || clean(student['كلمة السر'] ?? student.password ?? student.pass) !== password) {
    return { student: null, failed: false };
  }
  return { student, failed: false };
};

const getStudentName = (student: Record<string, unknown>) =>
  ['اسم الطالب', 'اسم الاب', 'اسم الأب', 'الكنية']
    .map((key) => clean(student[key]).slice(0, 120))
    .filter(Boolean)
    .join(' ').slice(0, 240) || clean(student.name ?? student.student_name).slice(0, 240) || 'طالب';

const getStudentYear = (student: Record<string, unknown>) => normalizeStudentYear(
  student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year
);

const getStudentIdentifier = (student: Record<string, unknown>) => clean(
  student['الرقم الجامعي'] ?? student.student_id ?? student.studentId ?? student['الرقم'] ?? student.id
);

const getFirstName = (name: unknown) => clean(name).split(/\s+/)[0] || 'طالب';

const enrichChatMessages = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  rows: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> => {
  const studentIds = [...new Set(rows.map((row) => clean(row.student_id)).filter(Boolean))];
  if (!studentIds.length) return rows.map((row) => ({ ...row, student_name: getFirstName(row.student_name), avatar_url: null }));

  const [{ data: students, error }, { data: supportStaff, error: supportError }] = await Promise.all([
    supabase.from('students').select('*').in('الرقم الجامعي', studentIds),
    supabase.from('student_chat_support_staff').select('student_id').eq('is_active', true).in('student_id', studentIds),
  ]);
  if (error) console.error('STUDENT_CHAT_AVATAR_LOOKUP_FAILED:', error.message);
  if (supportError) console.error('STUDENT_CHAT_SUPPORT_BADGE_LOOKUP_FAILED:', supportError.message);
  const supportStaffIds = new Set((supportStaff ?? []).map((staff) => clean(staff.student_id)));
  const profiles = new Map((students ?? []).map((student) => {
    const record = student as Record<string, unknown>;
    return [getStudentIdentifier(record), {
      firstName: getFirstName(
        clean(record['اسم الطالب'] ?? record.name ?? record.student_name)
          || rowNameFallback(rows, getStudentIdentifier(record))
      ),
      avatarUrl: clean(record.avatar_url) || null,
    }] as const;
  }));
  return rows.map((row) => {
    const profile = profiles.get(clean(row.student_id));
    return {
      ...row,
      student_name: profile?.firstName ?? getFirstName(row.student_name),
      avatar_url: profile?.avatarUrl ?? null,
      is_support_staff: row.is_support_staff === true || supportStaffIds.has(clean(row.student_id)),
    };
  });
};

const rowNameFallback = (rows: Array<Record<string, unknown>>, studentId: string) =>
  rows.find((row) => clean(row.student_id) === studentId)?.student_name;

const getUnreadMessages = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  studentId: string,
  studentYear: 'أولى' | 'ثانية'
) => {
  const { data: messages, error: messagesError } = await supabase.from('student_chat_messages')
    .select('id, student_id, student_name, student_year, message, created_at, attachment_name, attachment_type, attachment_size, is_support_staff')
    .eq('student_year', studentYear)
    .neq('student_id', studentId)
    .gte('created_at', new Date(Date.now() - retentionMs).toISOString())
    .order('created_at', { ascending: false })
    .limit(200);
  if (messagesError) {
    console.error('STUDENT_CHAT_UNREAD_MESSAGES_LOOKUP_FAILED:', messagesError.message);
    return { messages: null, error: messagesError };
  }
  if (!messages?.length) return { messages: [], error: null };

  const messageIds = messages.map((message) => message.id);
  const { data: reads, error: readsError } = await supabase.from('student_chat_message_reads')
    .select('message_id').eq('student_id', studentId).in('message_id', messageIds);
  if (readsError) {
    console.error('STUDENT_CHAT_UNREAD_RECEIPTS_LOOKUP_FAILED:', readsError.message);
    return { messages: null, error: readsError };
  }
  const readIds = new Set((reads ?? []).map((read) => read.message_id));
  const unreadMessages = messages.filter((message) => !readIds.has(message.id)).reverse() as Array<Record<string, unknown>>;
  return { messages: await enrichChatMessages(supabase, unreadMessages), error: null };
};

const getSettings = async (supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>) => {
  const { data, error } = await supabase.from('student_chat_settings')
    .select('is_open, is_open_first, is_open_second').eq('id', 1).maybeSingle();
  if (error || !data) {
    if (error) console.error('STUDENT_CHAT_SETTINGS_LOOKUP_FAILED:', error.message);
    return null;
  }
  return data as { is_open: boolean; is_open_first: boolean; is_open_second: boolean };
};

const isYearChatOpen = (
  settings: { is_open: boolean; is_open_first: boolean; is_open_second: boolean },
  year: 'أولى' | 'ثانية' | ''
) => year === 'أولى' ? settings.is_open_first : year === 'ثانية' && settings.is_open_second;

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  let attachment: File | null = null;
  try {
    if (request.headers.get('content-type')?.includes('multipart/form-data')) {
      const form = await request.formData();
      const formAttachment = form.get('file');
      attachment = formAttachment && typeof formAttachment !== 'string' ? formAttachment : null;
      body = Object.fromEntries([...form.entries()].filter(([key]) => key !== 'file'));
    } else {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return errorResponse('invalid-request', 400);
      }
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return errorResponse('invalid-request', 400);
  }

  const supabase = createSupabaseAdminClient();
  if (!supabase) return errorResponse('chat-service-not-configured', 503);

  if (body.action === 'validate-dashboard-session') {
    const username = clean(body.username);
    const password = clean(body.password);
    if (!username || username.length > 160 || !password || password.length > 300) {
      return errorResponse('credentials-required', 400);
    }
    const supervisor = await verifySupervisorCredentials(supabase, username, password);
    if (supervisor.failed) return errorResponse('supervisor-lookup-failed', 500);
    if (supervisor.valid) {
      const degree = String(supervisor.supervisor?.['الدرجة'] ?? supervisor.supervisor?.degree
        ?? supervisor.supervisor?.rank ?? supervisor.supervisor?.role ?? supervisor.supervisor?.level ?? '');
      const normalizedDegree = degree.replace(/\s+/g, '').toLocaleLowerCase();
      const isAllowedDegree = ['1', '١', '2', '٢', '3', '٣', '4', '٤', 'one', 'first', 'firstdegree', 'اولى',
        'الأولى', 'الدرجةالأولى', 'درجةالأولى', '1st', '1stdegree', 'moderator', 'مودرييتور', 'monitor', 'مراقب',
        'supervisor', 'سوبر', 'سوبرفايزور', 'super', 'supervisor2', 'second', 'ثانية', 'الثانية', 'third', 'ثالثة',
        'الثالثة', 'fayzor', 'fayzur', 'فايزور', 'faizur', 'four', 'fourth', '4th', '4thdegree', 'degree4', 'level4',
        'level4supervisor', 'رابعة', 'الرابعة', 'الدرجةالرابعة', 'درجةالرابعة', 'الدرجة4', 'درجة4', 'الدرجة٤',
        'درجة٤', 'supervisor4']
        .includes(normalizedDegree);
      if (!isAllowedDegree) return errorResponse('session-invalid', 401);
      return NextResponse.json({
        success: true,
        accountType: 'supervisor',
        degree,
      });
    }

    const authentication = await authenticateStudent(supabase, username, password);
    if (authentication.failed) return errorResponse('student-lookup-failed', 500);
    if (!authentication.student) return errorResponse('session-invalid', 401);
    const { data: supportStaff, error } = await supabase.from('student_chat_support_staff')
      .select('student_id').eq('student_id', username).eq('is_active', true).maybeSingle();
    if (error) {
      console.error('STUDENT_CHAT_SUPPORT_SESSION_LOOKUP_FAILED:', error.message);
      return errorResponse('support-staff-lookup-failed', 500);
    }
    if (!supportStaff) return errorResponse('session-invalid', 401);
    return NextResponse.json({
      success: true,
      accountType: 'support_student',
      studentName: getStudentName(authentication.student),
    });
  }

  if (body.action === 'support-login') {
    const studentId = clean(body.studentId);
    const password = clean(body.password);
    if (!studentId || studentId.length > 80 || !password || password.length > 256) {
      return errorResponse('student-credentials-required', 400);
    }

    const authentication = await authenticateStudent(supabase, studentId, password);
    if (authentication.failed) return errorResponse('student-lookup-failed', 500);
    const staffLookup = authentication.student
      ? await supabase.from('student_chat_support_staff').select('student_id, student_name')
        .eq('student_id', studentId).eq('is_active', true).maybeSingle()
      : { data: null, error: null };
    if (staffLookup.error) {
      console.error('STUDENT_CHAT_SUPPORT_LOGIN_LOOKUP_FAILED:', staffLookup.error.message);
      return errorResponse('support-staff-lookup-failed', 500);
    }
    if (!authentication.student || !staffLookup.data) {
      await writeServerAuditLog(request, {
        action: 'student_chat_support_login_failed',
        userType: 'support_supervisor',
        userId: studentId,
        username: studentId,
        details: { reason: authentication.student ? 'support-role-inactive' : 'invalid-student-credentials' },
      });
      return errorResponse('support-credentials-invalid', 401);
    }
    const supportName = getStudentName(authentication.student);
    await writeServerAuditLog(request, {
      action: 'student_chat_support_login',
      userType: 'support_supervisor',
      userId: studentId,
      username: studentId,
      fullName: supportName,
      details: { role: 'chat_support' },
    });
    return NextResponse.json({ success: true, studentId, studentName: supportName, features: ['chat'] });
  }

  if ([
    'support-staff-list',
    'support-staff-lookup',
    'grant-support-staff',
    'revoke-support-staff',
  ].includes(String(body.action))) {
    const username = clean(body.supervisorUsername);
    const password = clean(body.supervisorPassword);
    if (!username || !password) return errorResponse('supervisor-credentials-required', 400);
    const verification = await verifyFirstDegreeSupervisor(supabase, username, password);
    if (verification.failed) return errorResponse('supervisor-lookup-failed', 500);
    if (!verification.valid) return errorResponse('first-degree-supervisor-required', 403);

    if (body.action === 'support-staff-list') {
      const { data, error } = await supabase.from('student_chat_support_staff')
        .select('student_id, student_name, granted_at, granted_by')
        .eq('is_active', true).order('granted_at', { ascending: false });
      if (error) {
        console.error('STUDENT_CHAT_SUPPORT_STAFF_LIST_FAILED:', error.message);
        return errorResponse('support-staff-load-failed', 500);
      }
      return NextResponse.json({ success: true, staff: data ?? [] });
    }

    const studentId = clean(body.studentId);
    if (!studentId || studentId.length > 80) return errorResponse('student-id-required', 400);
    const { data: student, error: studentError } = await supabase.from('students').select('*')
      .eq('الرقم الجامعي', studentId).maybeSingle();
    if (studentError) {
      console.error('STUDENT_CHAT_SUPPORT_STUDENT_LOOKUP_FAILED:', studentError.message);
      return errorResponse('student-lookup-failed', 500);
    }
    if (!student) return errorResponse('student-not-found', 404);
    const studentName = getStudentName(student as Record<string, unknown>);

    if (body.action === 'support-staff-lookup') {
      return NextResponse.json({ success: true, student: { studentId, studentName } });
    }

    const staffChange = body.action === 'grant-support-staff'
      ? await supabase.from('student_chat_support_staff').upsert({
        student_id: studentId,
        student_name: studentName,
        granted_at: new Date().toISOString(),
        granted_by: username,
        is_active: true,
        deactivated_at: null,
        deactivated_by: null,
      }, { onConflict: 'student_id' })
      : await supabase.from('student_chat_support_staff').update({
        is_active: false,
        deactivated_at: new Date().toISOString(),
        deactivated_by: username,
      }).eq('student_id', studentId).eq('is_active', true);
    if (staffChange.error) {
      console.error('STUDENT_CHAT_SUPPORT_STAFF_CHANGE_FAILED:', staffChange.error.message);
      return errorResponse('support-staff-save-failed', 500);
    }
    await writeServerAuditLog(request, {
      action: body.action === 'grant-support-staff' ? 'student_chat_support_granted' : 'student_chat_support_revoked',
      userType: 'supervisor',
      username,
      details: { studentId, studentName, role: 'chat_support' },
    });
    return NextResponse.json({ success: true });
  }

  if ([
    'student-status',
    'student-messages',
    'send-message',
    'mark-read',
    'get-attachment',
    'edit-message',
    'delete-message',
    'support-student-profile',
    'support-mute-student',
    'support-chat-opened',
  ].includes(String(body.action))) {
    const studentId = clean(body.studentId);
    const password = clean(body.password);
    if (!studentId || studentId.length > 80 || !password || password.length > 256) {
      return errorResponse('student-credentials-required', 400);
    }

    const authentication = await authenticateStudent(supabase, studentId, password);
    if (authentication.failed) return errorResponse('student-lookup-failed', 500);
    if (!authentication.student) return errorResponse('student-credentials-invalid', 401);

    const { data: supportRole, error: supportRoleError } = await supabase.from('student_chat_support_staff')
      .select('student_id').eq('student_id', studentId).eq('is_active', true).maybeSingle();
    if (supportRoleError) {
      console.error('STUDENT_CHAT_SUPPORT_ROLE_LOOKUP_FAILED:', supportRoleError.message);
      if (['PGRST204', 'PGRST205', '42P01'].includes(supportRoleError.code ?? '')) {
        return errorResponse('chat-schema-out-of-date', 503);
      }
      return errorResponse('chat-status-failed', 500);
    }
    const isSupportStaff = Boolean(supportRole);
    const requestedYear = clean(body.studentYear);
    const studentYear = isSupportStaff && ['أولى', 'ثانية'].includes(requestedYear)
      ? requestedYear as 'أولى' | 'ثانية'
      : getStudentYear(authentication.student);

    if (body.action === 'support-student-profile') {
      if (!isSupportStaff) return errorResponse('support-role-inactive', 403);
      const targetStudentId = clean(body.targetStudentId);
      if (!targetStudentId || targetStudentId.length > 80 || !['أولى', 'ثانية'].includes(requestedYear)) {
        return errorResponse('invalid-student-id', 400);
      }
      const { data: target, error: targetError } = await supabase.from('students').select('*')
        .eq('الرقم الجامعي', targetStudentId).maybeSingle();
      if (targetError) {
        console.error('STUDENT_CHAT_SUPPORT_PROFILE_LOOKUP_FAILED:', targetError.message);
        return errorResponse('student-profile-load-failed', 500);
      }
      if (!target) return errorResponse('student-not-found', 404);
      const record = target as Record<string, unknown>;
      if (getStudentYear(record) !== requestedYear) return errorResponse('student-year-mismatch', 400);
      await writeServerAuditLog(request, {
        action: 'student_chat_support_profile_viewed',
        userType: 'support_supervisor',
        userId: studentId,
        username: studentId,
        fullName: getStudentName(authentication.student),
        details: { targetStudentId, targetStudentName: getStudentName(record), studentYear: requestedYear },
      });
      return NextResponse.json({
        success: true,
        student: {
          studentId: getStudentIdentifier(record),
          studentName: getStudentName(record),
          studentYear: requestedYear,
          phone: clean(record['رقم الهاتف'] ?? record.phone ?? record.mobile ?? record['رقم الموبايل']),
          avatarUrl: clean(record.avatar_url) || null,
        },
      });
    }

    if (body.action === 'support-chat-opened') {
      if (!isSupportStaff) return errorResponse('support-role-inactive', 403);
      if (!['أولى', 'ثانية'].includes(requestedYear)) return errorResponse('invalid-student-year', 400);
      await writeServerAuditLog(request, {
        action: 'student_chat_support_viewed',
        userType: 'support_supervisor',
        userId: studentId,
        username: studentId,
        fullName: getStudentName(authentication.student),
        details: { studentYear: requestedYear },
      });
      return NextResponse.json({ success: true });
    }

    if (body.action === 'support-mute-student') {
      if (!isSupportStaff) return errorResponse('support-role-inactive', 403);
      const targetStudentId = clean(body.targetStudentId);
      const reason = clean(body.reason).slice(0, 500);
      if (!targetStudentId || targetStudentId.length > 80 || !['أولى', 'ثانية'].includes(requestedYear) || !reason) {
        return errorResponse('mute-details-required', 400);
      }
      if (targetStudentId === studentId) return errorResponse('cannot-mute-self', 400);
      const { data: target, error: targetError } = await supabase.from('students').select('*')
        .eq('الرقم الجامعي', targetStudentId).maybeSingle();
      if (targetError) {
        console.error('STUDENT_CHAT_MUTE_STUDENT_LOOKUP_FAILED:', targetError.message);
        return errorResponse('student-lookup-failed', 500);
      }
      if (!target) return errorResponse('student-not-found', 404);
      if (getStudentYear(target as Record<string, unknown>) !== requestedYear) {
        return errorResponse('student-year-mismatch', 400);
      }
      const { data: targetStaff, error: targetStaffError } = await supabase.from('student_chat_support_staff')
        .select('student_id').eq('student_id', targetStudentId).eq('is_active', true).maybeSingle();
      if (targetStaffError) {
        console.error('STUDENT_CHAT_MUTE_ROLE_LOOKUP_FAILED:', targetStaffError.message);
        return errorResponse('support-staff-lookup-failed', 500);
      }
      if (targetStaff) return errorResponse('cannot-mute-support-staff', 403);
      const { data: existingBan, error: existingBanError } = await supabase.from('student_chat_bans')
        .select('expires_at').eq('student_id', targetStudentId).maybeSingle();
      if (existingBanError) {
        console.error('STUDENT_CHAT_EXISTING_BAN_LOOKUP_FAILED:', existingBanError.message);
        return errorResponse('chat-status-failed', 500);
      }
      if (existingBan && !existingBan.expires_at) return errorResponse('student-permanently-banned', 409);

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const targetRecord = target as Record<string, unknown>;
      const targetName = getStudentName(targetRecord);
      const { error: muteError } = await supabase.from('student_chat_bans').upsert({
        student_id: targetStudentId,
        student_name: targetName,
        banned_by: studentId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        reason,
      }, { onConflict: 'student_id' });
      if (muteError) {
        console.error('STUDENT_CHAT_MUTE_SAVE_FAILED:', muteError.message);
        return errorResponse('chat-mute-save-failed', 500);
      }
      await writeServerAuditLog(request, {
        action: 'student_chat_muted_24h',
        userType: 'support_supervisor',
        userId: studentId,
        username: studentId,
        fullName: getStudentName(authentication.student),
        details: { studentId: targetStudentId, studentName: targetName, studentYear: requestedYear, reason, expiresAt },
      });
      return NextResponse.json({ success: true, expiresAt });
    }

    const [settings, banResult] = await Promise.all([
      getSettings(supabase),
      supabase.from('student_chat_bans').select('student_id, expires_at, reason')
        .eq('student_id', studentId).maybeSingle(),
    ]);
    if (!settings) return errorResponse('chat-settings-not-configured', 503);
    const { data: ban, error: banError } = banResult;
    if (banError) {
      console.error('STUDENT_CHAT_BAN_LOOKUP_FAILED:', banError.message);
      return errorResponse('chat-status-failed', 500);
    }
    const expiresAt = ban?.expires_at ? Date.parse(String(ban.expires_at)) : null;
    const isMuted = Boolean(expiresAt && Number.isFinite(expiresAt) && expiresAt > Date.now());
    const isBanned = Boolean(ban && !ban.expires_at);

    if (body.action === 'student-status') {
      const ownYear = getStudentYear(authentication.student);
      const isOpen = isYearChatOpen(settings, ownYear);
      if ((!isOpen && !isSupportStaff) || isBanned || isMuted || (!ownYear && !isSupportStaff)) {
        return NextResponse.json({
          success: true,
          isOpen: isOpen || isSupportStaff,
          isBanned,
          isMuted,
          isSupportStaff,
          muteExpiresAt: isMuted ? ban?.expires_at : null,
          muteReason: isMuted ? ban?.reason : null,
          unreadMessages: [],
        });
      }
      const unread = ownYear ? await getUnreadMessages(supabase, studentId, ownYear) : { error: null, messages: [] };
      if (unread.error) return errorResponse('chat-unread-messages-load-failed', 500);
      return NextResponse.json({ success: true, isOpen: isOpen || isSupportStaff, isBanned, isMuted, isSupportStaff, unreadMessages: unread.messages ?? [] });
    }
    if (!studentYear) return errorResponse('student-year-not-configured', 403);
    if (!isSupportStaff && !isYearChatOpen(settings, studentYear)) return errorResponse('chat-closed', 403);
    if (isBanned) return errorResponse('student-chat-banned', 403);
    if (isMuted && ['send-message', 'edit-message', 'delete-message'].includes(String(body.action))) {
      return NextResponse.json({
        success: false,
        error: 'student-chat-muted',
        reason: ban?.reason ?? null,
        expiresAt: ban?.expires_at ?? null,
      }, { status: 403 });
    }

    if (body.action === 'mark-read') {
      const requestedIds = Array.isArray(body.messageIds)
        ? [...new Set(body.messageIds.filter((id): id is string => typeof id === 'string'))].slice(0, 50)
        : [];
      const messageIds = requestedIds.filter((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      );
      if (!messageIds.length) return NextResponse.json({ success: true });
      const { data: visibleMessages, error: visibleMessagesError } = await supabase.from('student_chat_messages')
        .select('id, student_id')
        .in('id', messageIds)
        .eq('student_year', studentYear)
        .gte('created_at', new Date(Date.now() - retentionMs).toISOString());
      if (visibleMessagesError) {
        console.error('STUDENT_CHAT_READ_MESSAGES_LOOKUP_FAILED:', visibleMessagesError.message);
        return errorResponse('chat-read-receipts-unavailable', 503);
      }
      const otherStudentsMessages = (visibleMessages ?? []).filter((message) => message.student_id !== studentId);
      if (!otherStudentsMessages.length) return NextResponse.json({ success: true });
      const { error } = await supabase.from('student_chat_message_reads')
        .upsert(otherStudentsMessages.map((message) => ({
          message_id: message.id,
          student_id: studentId,
        })), { onConflict: 'message_id,student_id', ignoreDuplicates: true });
      if (error) {
        console.error('STUDENT_CHAT_READ_RECEIPT_SAVE_FAILED:', error.message);
        return errorResponse('chat-read-receipts-unavailable', 503);
      }
      return NextResponse.json({ success: true });
    }

    if (body.action === 'send-message') {
      if (!isYearChatOpen(settings, studentYear)) return errorResponse('chat-closed', 403);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if ((!message && !attachment) || message.length > 1000) return errorResponse('invalid-message', 400);
      if (containsProhibitedLanguage(message)) return errorResponse('message-not-allowed', 400);

      let attachmentBytes: Uint8Array | null = null;
      let attachmentName = '';
      let attachmentType = '';
      if (attachment) {
        attachmentName = safeFileName(attachment.name);
        attachmentType = getAttachmentType(attachment);
        if (!attachment.size || attachment.size > maxAttachmentBytes || !attachmentTypes.has(attachmentType)) {
          return errorResponse('attachment-type-or-size-invalid', 400);
        }
        attachmentBytes = new Uint8Array(await attachment.arrayBuffer());
        if (!isValidAttachment(attachmentType, attachmentBytes)) {
          return errorResponse('attachment-content-invalid', 400);
        }
      }

      const { data: supportRole, error: supportRoleError } = await supabase.from('student_chat_support_staff')
        .select('student_id').eq('student_id', studentId).eq('is_active', true).maybeSingle();
      if (supportRoleError) {
        console.error('STUDENT_CHAT_SUPPORT_SEND_ROLE_LOOKUP_FAILED:', supportRoleError.message);
        return errorResponse('chat-status-failed', 500);
      }
      const { data, error } = await supabase.from('student_chat_messages').insert({
        student_id: studentId,
        student_name: getStudentName(authentication.student),
        student_year: studentYear,
        message,
        attachment_name: attachment ? attachmentName : null,
        attachment_type: attachment ? attachmentType : null,
        attachment_size: attachment ? attachment.size : null,
        is_support_staff: Boolean(supportRole),
      }).select('id, student_id, student_name, student_year, message, created_at, edited_at, attachment_name, attachment_type, attachment_size, is_support_staff').single();
      if (error) {
        console.error('STUDENT_CHAT_MESSAGE_INSERT_FAILED:', { code: error.code, message: error.message });
        if (attachment && ['PGRST204', 'PGRST205', '42P01', '23514'].includes(error.code ?? '')) {
          return errorResponse('chat-schema-out-of-date', 503);
        }
        return errorResponse('message-save-failed', 500);
      }
      if (attachmentBytes) {
        const { error: attachmentError } = await supabase.from('student_chat_attachments').insert({
          message_id: data.id,
          data_base64: Buffer.from(attachmentBytes).toString('base64'),
        });
        if (attachmentError) {
          console.error('STUDENT_CHAT_ATTACHMENT_SAVE_FAILED:', {
            code: attachmentError.code,
            message: attachmentError.message,
          });
          const { error: rollbackError } = await supabase.from('student_chat_messages').delete().eq('id', data.id);
          if (rollbackError) console.error('STUDENT_CHAT_ATTACHMENT_ROLLBACK_FAILED:', rollbackError.message);
          if (['PGRST204', 'PGRST205', '42P01'].includes(attachmentError.code ?? '')) {
            return errorResponse('chat-schema-out-of-date', 503);
          }
          return errorResponse('attachment-save-failed', 500);
        }
      }
      const enrichedMessages = await enrichChatMessages(supabase, [data as Record<string, unknown>]);
      return NextResponse.json({ success: true, message: enrichedMessages[0] });
    }

    if (body.action === 'get-attachment') {
      const messageId = clean(body.messageId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
        return errorResponse('invalid-message-id', 400);
      }
      const { data: messageRecord, error: messageError } = await supabase.from('student_chat_messages')
        .select('attachment_name, attachment_type')
        .eq('id', messageId)
        .eq('student_year', studentYear)
        .maybeSingle();
      if (messageError) {
        console.error('STUDENT_CHAT_ATTACHMENT_MESSAGE_LOOKUP_FAILED:', messageError.message);
        if (['PGRST204', 'PGRST205', '42P01'].includes(messageError.code ?? '')) {
          return errorResponse('chat-schema-out-of-date', 503);
        }
        return errorResponse('attachment-load-failed', 500);
      }
      if (!messageRecord?.attachment_name || !messageRecord.attachment_type) return errorResponse('attachment-not-found', 404);
      const { data, error } = await supabase.from('student_chat_attachments')
        .select('data_base64').eq('message_id', messageId).maybeSingle();
      if (error || !data) {
        if (error) console.error('STUDENT_CHAT_ATTACHMENT_LOOKUP_FAILED:', error.message);
        if (error && ['PGRST205', '42P01'].includes(error.code ?? '')) {
          return errorResponse('chat-schema-out-of-date', 503);
        }
        return errorResponse('attachment-load-failed', 500);
      }
      const filename = safeFileName(messageRecord.attachment_name);
      const disposition = String(messageRecord.attachment_type).startsWith('image/') ? 'inline' : 'attachment';
      return new Response(Buffer.from(String(data.data_base64), 'base64'), {
        headers: {
          'Content-Type': String(messageRecord.attachment_type),
          'Content-Length': String(Buffer.byteLength(String(data.data_base64), 'base64')),
          'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    if (body.action === 'edit-message') {
      const messageId = clean(body.messageId);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)
        || !message || message.length > 1000) return errorResponse('invalid-message', 400);
      if (containsProhibitedLanguage(message)) return errorResponse('message-not-allowed', 400);
      const { data: originalMessage, error: originalMessageError } = await supabase.from('student_chat_messages')
        .select('created_at')
        .eq('id', messageId)
        .eq('student_id', studentId)
        .eq('student_year', studentYear)
        .maybeSingle();
      if (originalMessageError) {
        console.error('STUDENT_CHAT_MESSAGE_EDIT_LOOKUP_FAILED:', originalMessageError.message);
        return errorResponse('message-edit-failed', 500);
      }
      if (!originalMessage) return errorResponse('message-not-found', 404);
      const createdAt = Date.parse(String(originalMessage.created_at));
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > messageEditWindowMs) {
        return errorResponse('message-edit-window-expired', 403);
      }
      const { data, error } = await supabase.from('student_chat_messages')
        .update({ message, edited_at: new Date().toISOString() })
        .eq('id', messageId)
        .eq('student_id', studentId)
        .eq('student_year', studentYear)
        .select('id, student_id, student_name, student_year, message, created_at, edited_at, attachment_name, attachment_type, attachment_size, is_support_staff')
        .maybeSingle();
      if (error) {
        console.error('STUDENT_CHAT_MESSAGE_EDIT_FAILED:', error.message);
        return errorResponse('message-edit-failed', 500);
      }
      if (!data) return errorResponse('message-not-found', 404);
      const enrichedMessages = await enrichChatMessages(supabase, [data as Record<string, unknown>]);
      return NextResponse.json({ success: true, message: enrichedMessages[0] });
    }

    if (body.action === 'delete-message') {
      const messageId = clean(body.messageId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
        return errorResponse('invalid-message-id', 400);
      }
      const { data, error } = await supabase.from('student_chat_messages')
        .delete().eq('id', messageId).eq('student_id', studentId).eq('student_year', studentYear).select('id').maybeSingle();
      if (error) {
        console.error('STUDENT_CHAT_MESSAGE_DELETE_FAILED:', error.message);
        return errorResponse('message-delete-failed', 500);
      }
      if (!data) return errorResponse('message-not-found', 404);
      return NextResponse.json({ success: true });
    }

    if (body.action !== 'student-messages') return errorResponse('invalid-action', 400);
    const after = typeof body.after === 'string' ? Date.parse(body.after) : Number.NaN;
    if (typeof body.after === 'string' && (!Number.isFinite(after) || after > Date.now() + 5000)) {
      return errorResponse('invalid-message-cursor', 400);
    }
    const cursor = new Date().toISOString();
    const minimumCreatedAt = Number.isFinite(after)
      ? new Date(Math.max(Date.now() - retentionMs, after - 1000)).toISOString()
      : new Date(Date.now() - retentionMs).toISOString();
    const { data: messages, error: messagesError } = await supabase.from('student_chat_messages')
      .select('id, student_id, student_name, student_year, message, created_at, edited_at, attachment_name, attachment_type, attachment_size, is_support_staff')
      .eq('student_year', studentYear)
      .gte('created_at', minimumCreatedAt)
      .order('created_at', { ascending: false })
      .limit(200);
    if (messagesError) {
      console.error('STUDENT_CHAT_MESSAGES_LOOKUP_FAILED:', {
        code: messagesError.code,
        message: messagesError.message,
      });
      if (['PGRST204', 'PGRST205', '42P01'].includes(messagesError.code ?? '')) {
        return errorResponse('chat-schema-out-of-date', 503);
      }
      return errorResponse('chat-messages-load-failed', 500);
    }
    const sortedMessages = (messages ?? []).reverse();
    const readCounts = new Map<string, number>();
    if (sortedMessages.length) {
      const { data: counts, error: readError } = await supabase.rpc('student_chat_read_counts', {
        p_message_ids: sortedMessages.map((message) => message.id),
      });
      if (readError) {
        console.error('STUDENT_CHAT_READ_RECEIPTS_LOOKUP_FAILED:', readError.message);
        return errorResponse('chat-read-receipts-unavailable', 503);
      }
      for (const count of (counts ?? []) as Array<{ message_id: string; viewer_count: number | string }>) {
        readCounts.set(count.message_id, Number(count.viewer_count));
      }
    }

    return NextResponse.json({
      success: true,
      cursor,
      messages: (await enrichChatMessages(supabase, sortedMessages as Array<Record<string, unknown>>)).map((message) => ({
        ...message,
        viewer_count: readCounts.get(String(message.id)) ?? 0,
      })),
    });
  }

  if ([
    'admin-state',
    'admin-messages',
    'admin-get-attachment',
    'set-open',
    'set-year-open',
    'ban-student',
    'unban-student',
    'mute-student',
  ].includes(String(body.action))) {
    const supervisorUsername = clean(body.supervisorUsername);
    const supervisorPassword = clean(body.supervisorPassword);
    const supportStudentId = clean(body.supportStudentId);
    const supportPassword = clean(body.supportPassword);
    let supportOperator: { studentId: string; studentName: string } | null = null;
    let username = supervisorUsername;

    if (supportStudentId) {
      if (supportStudentId.length > 80 || !supportPassword || supportPassword.length > 256) {
        return errorResponse('support-credentials-required', 400);
      }
      const authentication = await authenticateStudent(supabase, supportStudentId, supportPassword);
      if (authentication.failed) return errorResponse('student-lookup-failed', 500);
      if (!authentication.student) return errorResponse('support-credentials-invalid', 401);
      const { data: staff, error: staffError } = await supabase.from('student_chat_support_staff')
        .select('student_id').eq('student_id', supportStudentId).eq('is_active', true).maybeSingle();
      if (staffError) {
        console.error('STUDENT_CHAT_SUPPORT_AUTHORIZATION_FAILED:', staffError.message);
        return errorResponse('support-staff-lookup-failed', 500);
      }
      if (!staff) return errorResponse('support-role-inactive', 403);
      supportOperator = { studentId: supportStudentId, studentName: getStudentName(authentication.student) };
      username = supportOperator.studentId;
    } else {
      if (!supervisorUsername || supervisorUsername.length > 160 || !supervisorPassword || supervisorPassword.length > 300) {
        return errorResponse('supervisor-credentials-required', 400);
      }
      const verification = await verifyFirstDegreeSupervisor(supabase, supervisorUsername, supervisorPassword);
      if (verification.failed) return errorResponse('supervisor-lookup-failed', 500);
      if (!verification.valid) return errorResponse('first-degree-supervisor-required', 403);
    }

    if (supportOperator && !['admin-state', 'admin-messages', 'admin-get-attachment', 'mute-student'].includes(String(body.action))) {
      return errorResponse('support-action-not-allowed', 403);
    }

    if (body.action === 'admin-messages') {
      const studentYear = body.studentYear;
      if (!['أولى', 'ثانية'].includes(String(studentYear))) return errorResponse('invalid-student-year', 400);
      const { data: messages, error } = await supabase.from('student_chat_messages')
        .select('id, student_id, student_name, student_year, message, created_at, edited_at, attachment_name, attachment_type, attachment_size, is_support_staff')
        .eq('student_year', studentYear)
        .gte('created_at', new Date(Date.now() - retentionMs).toISOString())
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) {
        console.error('STUDENT_CHAT_ADMIN_MESSAGES_LOOKUP_FAILED:', error.message);
        if (['PGRST204', 'PGRST205', '42P01'].includes(error.code ?? '')) {
          return errorResponse('chat-schema-out-of-date', 503);
        }
        return errorResponse('chat-admin-messages-load-failed', 500);
      }
      return NextResponse.json({
        success: true,
        messages: await enrichChatMessages(supabase, (messages ?? []) as Array<Record<string, unknown>>),
      });
    }

    if (body.action === 'admin-get-attachment') {
      const studentYear = body.studentYear;
      const messageId = clean(body.messageId);
      if (!['أولى', 'ثانية'].includes(String(studentYear))
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
        return errorResponse('invalid-message-id', 400);
      }
      const { data: messageRecord, error: messageError } = await supabase.from('student_chat_messages')
        .select('attachment_name, attachment_type')
        .eq('id', messageId)
        .eq('student_year', studentYear)
        .maybeSingle();
      if (messageError) {
        console.error('STUDENT_CHAT_ADMIN_ATTACHMENT_MESSAGE_LOOKUP_FAILED:', messageError.message);
        return errorResponse('attachment-load-failed', 500);
      }
      if (!messageRecord?.attachment_name || !messageRecord.attachment_type) {
        return errorResponse('attachment-not-found', 404);
      }
      const { data, error } = await supabase.from('student_chat_attachments')
        .select('data_base64').eq('message_id', messageId).maybeSingle();
      if (error || !data) {
        if (error) console.error('STUDENT_CHAT_ADMIN_ATTACHMENT_LOOKUP_FAILED:', error.message);
        return errorResponse('attachment-load-failed', 500);
      }
      const filename = safeFileName(messageRecord.attachment_name);
      const disposition = String(messageRecord.attachment_type).startsWith('image/') ? 'inline' : 'attachment';
      return new Response(Buffer.from(String(data.data_base64), 'base64'), {
        headers: {
          'Content-Type': String(messageRecord.attachment_type),
          'Content-Length': String(Buffer.byteLength(String(data.data_base64), 'base64')),
          'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        },
      });
    }

    if (body.action === 'admin-state') {
      const settings = await getSettings(supabase);
      if (!settings) return errorResponse('chat-settings-not-configured', 503);
      const { data: bans, error } = await supabase.from('student_chat_bans')
        .select('student_id, student_name, created_at, banned_by, expires_at, reason')
        .order('created_at', { ascending: false });
      if (error) {
        console.error('STUDENT_CHAT_BANS_LOOKUP_FAILED:', error.message);
        return errorResponse('chat-bans-load-failed', 500);
      }
      const visibleBans = supportOperator
        ? (bans ?? []).filter((ban) => Boolean(
          ban.expires_at && Date.parse(String(ban.expires_at)) > Date.now()
        ))
        : bans ?? [];
      return NextResponse.json({
        success: true,
        isOpen: settings.is_open_first || settings.is_open_second,
        isOpenFirst: settings.is_open_first,
        isOpenSecond: settings.is_open_second,
        bans: visibleBans,
      });
    }

    if (body.action === 'set-open') {
      if (typeof body.isOpen !== 'boolean') return errorResponse('invalid-chat-state', 400);
      const { data, error } = await supabase.from('student_chat_settings').update({
        is_open: body.isOpen,
        is_open_first: body.isOpen,
        is_open_second: body.isOpen,
        updated_at: new Date().toISOString(),
        updated_by: username,
      }).eq('id', 1).select('id, is_open_first, is_open_second').maybeSingle();
      if (error) {
        console.error('STUDENT_CHAT_SETTINGS_UPDATE_FAILED:', error.message);
        return errorResponse('chat-settings-update-failed', 500);
      }
      if (!data) return errorResponse('chat-settings-not-configured', 503);
      return NextResponse.json({
        success: true,
        isOpen: body.isOpen,
        isOpenFirst: data.is_open_first,
        isOpenSecond: data.is_open_second,
      });
    }

    if (body.action === 'set-year-open') {
      const year = body.studentYear;
      if (!['أولى', 'ثانية'].includes(String(year)) || typeof body.isOpen !== 'boolean') {
        return errorResponse('invalid-chat-state', 400);
      }
      const settingColumn = year === 'أولى' ? 'is_open_first' : 'is_open_second';
      const { data, error } = await supabase.from('student_chat_settings').update({
        [settingColumn]: body.isOpen,
        updated_at: new Date().toISOString(),
        updated_by: username,
      }).eq('id', 1).select('id, is_open_first, is_open_second').maybeSingle();
      if (error) {
        console.error('STUDENT_CHAT_YEAR_SETTINGS_UPDATE_FAILED:', error.message);
        return errorResponse('chat-settings-update-failed', 500);
      }
      if (!data) return errorResponse('chat-settings-not-configured', 503);
      return NextResponse.json({
        success: true,
        studentYear: year,
        isOpen: year === 'أولى' ? data.is_open_first : data.is_open_second,
        isChatOpen: data.is_open_first || data.is_open_second,
        isOpenFirst: data.is_open_first,
        isOpenSecond: data.is_open_second,
      });
    }

    const studentId = clean(body.studentId);
    if (!studentId || studentId.length > 80) return errorResponse('student-id-required', 400);
    if (body.action === 'mute-student') {
      if (!supportOperator) return errorResponse('support-action-not-allowed', 403);
      const studentYear = body.studentYear;
      const reason = clean(body.reason).slice(0, 500);
      if (!['أولى', 'ثانية'].includes(String(studentYear)) || !reason) {
        return errorResponse('mute-details-required', 400);
      }
      if (studentId === supportOperator.studentId) return errorResponse('cannot-mute-self', 400);
      const { data: student, error: studentError } = await supabase.from('students').select('*')
        .eq('الرقم الجامعي', studentId).maybeSingle();
      if (studentError) {
        console.error('STUDENT_CHAT_MUTE_STUDENT_LOOKUP_FAILED:', studentError.message);
        return errorResponse('student-lookup-failed', 500);
      }
      if (!student) return errorResponse('student-not-found', 404);
      if (getStudentYear(student as Record<string, unknown>) !== studentYear) {
        return errorResponse('student-year-mismatch', 400);
      }
      const { data: targetStaff, error: targetStaffError } = await supabase.from('student_chat_support_staff')
        .select('student_id').eq('student_id', studentId).eq('is_active', true).maybeSingle();
      if (targetStaffError) {
        console.error('STUDENT_CHAT_MUTE_ROLE_LOOKUP_FAILED:', targetStaffError.message);
        return errorResponse('support-staff-lookup-failed', 500);
      }
      if (targetStaff) return errorResponse('cannot-mute-support-staff', 403);

      const { data: existingBan, error: existingBanError } = await supabase.from('student_chat_bans')
        .select('expires_at').eq('student_id', studentId).maybeSingle();
      if (existingBanError) {
        console.error('STUDENT_CHAT_EXISTING_BAN_LOOKUP_FAILED:', existingBanError.message);
        return errorResponse('chat-status-failed', 500);
      }
      if (existingBan && !existingBan.expires_at) {
        return errorResponse('student-permanently-banned', 409);
      }

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const studentName = getStudentName(student as Record<string, unknown>);
      const { error } = await supabase.from('student_chat_bans').upsert({
        student_id: studentId,
        student_name: studentName,
        banned_by: supportOperator.studentId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        reason,
      }, { onConflict: 'student_id' });
      if (error) {
        console.error('STUDENT_CHAT_MUTE_SAVE_FAILED:', error.message);
        return errorResponse('chat-mute-save-failed', 500);
      }
      await writeServerAuditLog(request, {
        action: 'student_chat_muted_24h',
        userType: 'support_supervisor',
        userId: supportOperator.studentId,
        username: supportOperator.studentId,
        fullName: supportOperator.studentName,
        details: { studentId, studentName, studentYear, reason, expiresAt },
      });
      return NextResponse.json({ success: true, expiresAt });
    }

    if (body.action === 'ban-student') {
      const authentication = await supabase.from('students').select('*')
        .eq('الرقم الجامعي', studentId).maybeSingle();
      if (authentication.error) {
        console.error('STUDENT_CHAT_BAN_STUDENT_LOOKUP_FAILED:', authentication.error.message);
        return errorResponse('student-lookup-failed', 500);
      }
      if (!authentication.data) return errorResponse('student-not-found', 404);
      const student = authentication.data as Record<string, unknown>;
      const { error } = await supabase.from('student_chat_bans').upsert({
        student_id: studentId,
        student_name: getStudentName(student),
        banned_by: username,
        created_at: new Date().toISOString(),
        expires_at: null,
        reason: null,
      }, { onConflict: 'student_id' });
      if (error) {
        console.error('STUDENT_CHAT_BAN_SAVE_FAILED:', error.message);
        return errorResponse('chat-ban-save-failed', 500);
      }
      return NextResponse.json({ success: true });
    }

    const { error } = await supabase.from('student_chat_bans').delete().eq('student_id', studentId);
    if (error) {
      console.error('STUDENT_CHAT_UNBAN_FAILED:', error.message);
      return errorResponse('chat-unban-failed', 500);
    }
    return NextResponse.json({ success: true });
  }

  return errorResponse('invalid-action', 400);
}
