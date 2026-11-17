import { randomInt, createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { sendEmail } from '../../../../../lib/email';
import { isFirstLoginContactMatch, normalizeFirstLoginStudentId } from '../../../../../lib/firstLogin';
import { createSupabaseAdminClient } from '../../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown, maxLength = 300) => String(value ?? '').trim().slice(0, maxLength);
const normalizeEmail = (value: unknown) => clean(value, 320).toLocaleLowerCase();

const maskEmail = (email: string) => {
  const [name, domain] = email.split('@');
  return name && domain ? `${name.slice(0, 2)}***@${domain}` : 'البريد الإلكتروني المسجل';
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const hashCode = (studentId: string, code: string, secret: string) => createHash('sha256')
  .update(`${secret}:${studentId}:${code}`)
  .digest('hex');

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
  const body = parsed as { studentId?: string; contact?: string; emailFallback?: boolean };

  const studentId = clean(body.studentId, 80);
  const contact = clean(body.contact, 320);
  if (!studentId || (!contact && body.emailFallback !== true)) {
    return NextResponse.json({ success: false, error: 'first-login-contact-required' }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabase || !secret) {
    return NextResponse.json({ success: false, error: 'first-login-service-not-configured' }, { status: 503 });
  }

  const studentIdCandidates = [...new Set([studentId, normalizeFirstLoginStudentId(studentId)].filter(Boolean))];
  const studentLookups = await Promise.all(studentIdCandidates.map((candidate) => supabase.from('students')
    .select('"الرقم الجامعي", "كلمة السر", "اسم الطالب", "البريد الإلكتروني", "رقم الهاتف", force_password_change')
    .eq('الرقم الجامعي', candidate)
    .maybeSingle()));
  const studentError = studentLookups.find((lookup) => lookup.error)?.error;
  if (studentError) {
    console.error('[first-login-code] student lookup failed:', studentError.message);
    return NextResponse.json({ success: false, error: 'first-login-student-lookup-failed' }, { status: 500 });
  }

  const student = studentLookups.find((lookup) => lookup.data)?.data;
  const studentRecord = student as Record<string, unknown> | null;
  const canonicalStudentId = clean(studentRecord?.['الرقم الجامعي'], 80) || studentId;
  const studentEmail = normalizeEmail(studentRecord?.['البريد الإلكتروني']);
  const password = clean(studentRecord?.['كلمة السر']);
  const requiresFirstLogin = studentRecord?.force_password_change === true
    || ['true', '1', 'yes'].includes(clean(studentRecord?.force_password_change).toLocaleLowerCase());
  if (!studentRecord || !requiresFirstLogin || password) {
    return NextResponse.json({ success: false, error: 'first-login-setup-not-required' }, { status: 409 });
  }

  if (body.emailFallback !== true) {
    if (!isFirstLoginContactMatch(contact, studentEmail, studentRecord['رقم الهاتف'])) {
      return NextResponse.json({ success: false, error: 'first-login-contact-mismatch' }, { status: 401 });
    }
    return NextResponse.json({ success: true, verified: true });
  }
  if (!studentEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail)) {
    return NextResponse.json({ success: false, error: 'first-login-email-missing' }, { status: 400 });
  }

  const now = new Date();
  const { data: recentCodes, error: recentCodeError } = await supabase.from('student_first_login_codes')
    .select('id')
    .eq('student_id', canonicalStudentId)
    .gt('created_at', new Date(now.getTime() - 60_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(1);
  if (recentCodeError) {
    console.error('[first-login-code] rate-limit lookup failed:', recentCodeError.message);
    return NextResponse.json({ success: false, error: 'first-login-code-table-unavailable' }, { status: 500 });
  }
  if (recentCodes?.length) {
    return NextResponse.json({ success: false, error: 'first-login-code-recently-sent' }, { status: 429 });
  }

  const code = String(randomInt(100000, 1000000));
  const { data: codeRow, error: codeError } = await supabase.from('student_first_login_codes')
    .insert({
      student_id: canonicalStudentId,
      code_hash: hashCode(canonicalStudentId, code, secret),
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
    })
    .select('id')
    .single();
  if (codeError) {
    console.error('[first-login-code] code save failed:', codeError.message);
    return NextResponse.json({ success: false, error: 'first-login-code-save-failed' }, { status: 500 });
  }

  const studentName = clean(studentRecord['اسم الطالب'], 120) || 'الطالب';
  const emailResult = await sendEmail({
    to: studentEmail,
    subject: 'رمز تفعيل حساب الطالب',
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8"><h2>تفعيل الحساب لأول مرة</h2><p>مرحبًا ${escapeHtml(studentName)}،</p><p>رمز التحقق الخاص بك:</p><div style="font-size:30px;font-weight:800;letter-spacing:8px;color:#0f766e">${code}</div><p>الرمز صالح لمدة 15 دقيقة، ولا تشاركه مع أحد.</p></div>`,
  });
  if (!emailResult.success) {
    const { error: invalidateError } = await supabase.from('student_first_login_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('id', codeRow.id);
    if (invalidateError) console.error('[first-login-code] failed to invalidate unsent code:', invalidateError.message);
    return NextResponse.json({ success: false, error: 'first-login-code-email-failed' }, { status: 502 });
  }

  return NextResponse.json({ success: true, destination: maskEmail(studentEmail) });
}
