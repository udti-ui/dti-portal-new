import { NextResponse } from 'next/server';
import { writeServerAuditLog } from '../../../../lib/auditLogServer';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown, maxLength = 500) => String(value ?? '').trim().slice(0, maxLength);
const normalizeYear = (value: unknown) => clean(value).replace(/\s+/g, '').toLocaleLowerCase();

export async function POST(request: Request) {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'invalid-json-body' }, { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ success: false, error: 'invalid-request-body' }, { status: 400 });
  }

  const body = parsed as Record<string, unknown>;
  const studentId = clean(body.studentId, 80);
  const currentPassword = clean(body.currentPassword, 300);
  const newPassword = clean(body.newPassword, 300);
  if (!studentId || !currentPassword || newPassword.length < 8) {
    return NextResponse.json({ success: false, error: 'invalid-first-login-password' }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  if (!supabase) return NextResponse.json({ success: false, error: 'password-service-not-configured' }, { status: 503 });

  const { data: rows, error } = await supabase.from('students').select('*').eq('الرقم الجامعي', studentId).limit(1);
  if (error) {
    console.error('[first-login-password] student lookup failed:', error.message);
    return NextResponse.json({ success: false, error: 'student-lookup-failed' }, { status: 500 });
  }
  const student = rows?.[0] as Record<string, unknown> | undefined;
  if (!student || clean(student['كلمة السر'] ?? student.password) !== currentPassword) {
    return NextResponse.json({ success: false, error: 'student-credentials-invalid' }, { status: 401 });
  }

  const year = normalizeYear(student['السنه الدراسية'] ?? student['السنة الدراسية']);
  const firstYear = ['1', '١', 'اولى', 'أولى', 'الأولى', 'first'].includes(year);
  const requiresChange = student.force_password_change === true
    || ['true', '1', 'yes'].includes(clean(student.force_password_change).toLocaleLowerCase());
  if (!firstYear || !requiresChange) {
    return NextResponse.json({ success: false, error: 'first-login-change-not-required' }, { status: 409 });
  }

  const { error: updateError } = await supabase.from('students')
    .update({ 'كلمة السر': newPassword, force_password_change: false })
    .eq('الرقم الجامعي', studentId);
  if (updateError) {
    console.error('[first-login-password] password update failed:', updateError.message);
    return NextResponse.json({ success: false, error: 'password-update-failed' }, { status: 500 });
  }

  const fullName = [
    student['اسم الطالب'],
    student['اسم الاب'] ?? student['اسم الأب'],
    student['الكنية'],
  ].map((part) => clean(part, 120)).filter(Boolean).join(' ');
  let auditWarning = false;
  try {
    await writeServerAuditLog(request, {
      action: 'student_first_login_password_changed',
      userType: 'student',
      userId: studentId,
      username: fullName,
      fullName,
    });
  } catch (auditError) {
    console.error('[first-login-password] audit logging failed:', auditError);
    auditWarning = true;
  }

  return NextResponse.json({ success: true, auditWarning });
}
