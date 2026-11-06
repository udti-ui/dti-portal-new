import { NextResponse } from 'next/server';
import { supabase } from '../../../../../lib/supabase';
import { normalizeStudentIdentifier } from '../../../../../lib/studentData';
import { writeServerAuditLog } from '../../../../../lib/auditLogServer';

export const dynamic = 'force-dynamic';

const normalize = (value: unknown) => String(value ?? '').trim();

const jsonError = (error: string, status: number, details?: unknown) => NextResponse.json({
  success: false,
  error,
  ...(details ? { details } : {}),
}, { status });

const errorDetails = (error: unknown) => error instanceof Error
  ? error.message
  : String((error as { message?: unknown })?.message ?? error);

export async function POST(request: Request) {
  let stage = 'start';
  try {
    stage = 'parse-request';
    const body = await request.json() as { identifier?: string; code?: string; newPassword?: string };
    const identifier = normalize(body.identifier);
    const normalizedIdentifier = normalizeStudentIdentifier(identifier);
    const code = normalize(body.code);
    const newPassword = normalize(body.newPassword);
    if (!identifier || !/^\d{6}$/.test(code) || newPassword.length < 8) {
      return jsonError('invalid-reset-input', 400, 'أدخل بيانات صحيحة ورمزًا من 6 أرقام وكلمة مرور من 8 محارف على الأقل.');
    }

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) {
      return jsonError('supabase-not-configured', 503, 'متغيرات Supabase غير موجودة في بيئة الخادم.');
    }

    stage = 'find-student';
    const studentColumns = '"الرقم الجامعي", "اسم الطالب", "اسم الاب", "الكنية", "البريد الإلكتروني", "رقم الهاتف"';
    const idCandidates = [...new Set([identifier, normalizedIdentifier].filter(Boolean))];
    const lookups = await Promise.all([
      ...idCandidates.map((candidate) => supabase.from('students').select(studentColumns)
        .eq('الرقم الجامعي', candidate).maybeSingle()),
      ...(identifier.includes('@')
        ? [supabase.from('students').select(studentColumns)
          .ilike('البريد الإلكتروني', identifier.replace(/[\\%_]/g, '\\$&')).maybeSingle()]
        : /^\+?[\d\s()-]+$/.test(identifier)
          ? [supabase.from('students').select(studentColumns).eq('رقم الهاتف', identifier).maybeSingle()]
          : []),
    ]);
    const lookupError = lookups.find((lookup) => lookup.error)?.error;
    if (lookupError) {
      console.error('RESET_PASSWORD_ERROR:', { stage, code: lookupError.code, message: lookupError.message, details: lookupError.details, hint: lookupError.hint });
      return jsonError('student-query-failed', 500, lookupError.message);
    }
    const student = lookups.find((lookup) => lookup.data)?.data as Record<string, unknown> | undefined;
    if (!student) return jsonError('student-not-found', 404, 'لم يتم العثور على الطالب أو البريد الإلكتروني.');

    const studentIdKey = 'الرقم الجامعي';
    const studentId = normalize(student['الرقم الجامعي']);
    const email = normalize(student['البريد الإلكتروني']);
    if (!email) return jsonError('student-email-missing', 400, 'لا يوجد بريد إلكتروني مسجل لهذا الطالب.');
    stage = 'read-reset-code';
    const { data: resetRows, error: resetError } = await supabase
      .from('password_reset_requests')
      .select('*')
      .eq('email', email)
      .eq('code', code)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (resetError) {
      console.error('RESET_PASSWORD_ERROR:', { stage, code: resetError.code, message: resetError.message, details: resetError.details, hint: resetError.hint });
      return jsonError('password-reset-table-failed', 500, resetError.message);
    }

    const resetRow = Array.isArray(resetRows) ? resetRows[0] as Record<string, unknown> | undefined : undefined;
    if (!resetRow) {
      return jsonError('invalid-or-expired-code', 400, 'كود التحقق غير صحيح أو منتهي الصلاحية.');
    }

    const resetId = resetRow.id;

    const passwordPayload = { 'كلمة السر': newPassword, password: newPassword };
    stage = 'update-password';
    const update = await supabase.from('students').update(passwordPayload).eq(studentIdKey, studentId);
    if (update.error) {
      const fallback = await supabase.from('students').update({ 'كلمة السر': newPassword }).eq(studentIdKey, studentId);
      if (fallback.error) return jsonError('password-update-failed', 500, fallback.error.message);
    }

    const fullName = [
      student['اسم الطالب'] ?? student.name ?? student.student_name,
      student['اسم الاب'] ?? student['اسم الأب'] ?? student.father_name,
      student['الكنية'] ?? student.family_name ?? student.surname,
    ].map(normalize).filter(Boolean).join(' ');
    try {
      await writeServerAuditLog(request, {
        action: 'student_password_reset',
        userType: 'student',
        userId: studentId,
        username: fullName,
        fullName,
        details: { method: 'password-recovery' },
      });
    } catch (auditError) {
      console.error('Password reset audit logging failed:', auditError);
    }

    const { error: markUsedError } = await supabase
      .from('password_reset_requests')
      .update({ used: true })
      .eq('id', resetId);
    if (markUsedError) return jsonError('reset-code-update-failed', 500, markUsedError.message);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('RESET_PASSWORD_ERROR:', error);
    console.error('RESET_PASSWORD_STAGE:', stage);
    return jsonError('password-reset-failed', 500, errorDetails(error));
  }
}
