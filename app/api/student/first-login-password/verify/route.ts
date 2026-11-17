import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { writeServerAuditLog } from '../../../../../lib/auditLogServer';
import { isFirstLoginContactMatch, normalizeFirstLoginStudentId } from '../../../../../lib/firstLogin';
import { createSupabaseAdminClient } from '../../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => String(value ?? '').trim();
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
  const body = parsed as { studentId?: string; contact?: string; code?: string; newPassword?: string };

  const studentId = clean(body.studentId);
  const contact = clean(body.contact);
  const code = clean(body.code);
  const newPassword = clean(body.newPassword);
  const hasValidCode = /^\d{6}$/.test(code);
  if (!studentId || (!contact && !hasValidCode) || (contact && code) || newPassword.length < 8 || newPassword.length > 128) {
    return NextResponse.json({ success: false, error: 'invalid-first-login-input' }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabase || !secret) {
    return NextResponse.json({ success: false, error: 'first-login-service-not-configured' }, { status: 503 });
  }

  const studentIdCandidates = [...new Set([studentId, normalizeFirstLoginStudentId(studentId)].filter(Boolean))];
  const studentLookups = await Promise.all(studentIdCandidates.map((candidate) => supabase.from('students')
    .select('"الرقم الجامعي", "كلمة السر", "اسم الطالب", "اسم الاب", "الكنية", "البريد الإلكتروني", "رقم الهاتف", force_password_change')
    .eq('الرقم الجامعي', candidate)
    .maybeSingle()));
  const studentError = studentLookups.find((lookup) => lookup.error)?.error;
  if (studentError) {
    console.error('[first-login-verify] student lookup failed:', studentError.message);
    return NextResponse.json({ success: false, error: 'first-login-student-lookup-failed' }, { status: 500 });
  }

  const student = studentLookups.find((lookup) => lookup.data)?.data;
  const studentRecord = student as Record<string, unknown> | null;
  const canonicalStudentId = clean(studentRecord?.['الرقم الجامعي']) || studentId;
  const requiresFirstLogin = studentRecord?.force_password_change === true
    || ['true', '1', 'yes'].includes(clean(studentRecord?.force_password_change).toLocaleLowerCase());
  if (!studentRecord || !requiresFirstLogin || clean(studentRecord['كلمة السر'])) {
    return NextResponse.json({ success: false, error: 'first-login-setup-not-required' }, { status: 409 });
  }

  const now = new Date().toISOString();
  if (contact) {
    if (!isFirstLoginContactMatch(contact, studentRecord['البريد الإلكتروني'], studentRecord['رقم الهاتف'])) {
      return NextResponse.json({ success: false, error: 'first-login-contact-mismatch' }, { status: 401 });
    }
  } else {
    const { data: codes, error: codeError } = await supabase.from('student_first_login_codes')
      .select('id, code_hash, attempts')
      .eq('student_id', canonicalStudentId)
      .is('used_at', null)
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1);
    if (codeError) {
      console.error('[first-login-verify] code lookup failed:', codeError.message);
      return NextResponse.json({ success: false, error: 'first-login-code-table-unavailable' }, { status: 500 });
    }

    const codeRecord = codes?.[0] as Record<string, unknown> | undefined;
    if (!codeRecord) {
      return NextResponse.json({ success: false, error: 'invalid-or-expired-first-login-code' }, { status: 400 });
    }
    const attempts = Number(codeRecord.attempts) || 0;
    if (attempts >= 5) {
      return NextResponse.json({ success: false, error: 'too-many-first-login-attempts' }, { status: 429 });
    }

    const suppliedHash = Buffer.from(hashCode(canonicalStudentId, code, secret), 'hex');
    const storedHashText = String(codeRecord.code_hash ?? '');
    const storedHash = /^[a-f\d]{64}$/i.test(storedHashText) ? Buffer.from(storedHashText, 'hex') : Buffer.alloc(0);
    const codeMatches = storedHash.length === suppliedHash.length && timingSafeEqual(storedHash, suppliedHash);
    if (!codeMatches) {
      const { error: attemptError } = await supabase.from('student_first_login_codes')
        .update({ attempts: attempts + 1 })
        .eq('id', codeRecord.id)
        .eq('attempts', attempts);
      if (attemptError) {
        console.error('[first-login-verify] failed to record invalid attempt:', attemptError.message);
        return NextResponse.json({ success: false, error: 'first-login-attempt-save-failed' }, { status: 500 });
      }
      return NextResponse.json({ success: false, error: 'invalid-or-expired-first-login-code' }, { status: 400 });
    }

    const { data: consumedCode, error: consumeError } = await supabase.from('student_first_login_codes')
      .update({ used_at: now })
      .eq('id', codeRecord.id)
      .eq('code_hash', storedHashText)
      .is('used_at', null)
      .gt('expires_at', now)
      .select('id')
      .maybeSingle();
    if (consumeError) {
      console.error('[first-login-verify] code consumption failed:', consumeError.message);
      return NextResponse.json({ success: false, error: 'first-login-code-consume-failed' }, { status: 500 });
    }
    if (!consumedCode) {
      return NextResponse.json({ success: false, error: 'invalid-or-expired-first-login-code' }, { status: 400 });
    }
  }

  const { data: updatedStudent, error: updateError } = await supabase.from('students')
    .update({ 'كلمة السر': newPassword, force_password_change: false })
    .eq('الرقم الجامعي', canonicalStudentId)
    .eq('force_password_change', true)
    .is('كلمة السر', null)
    .select('"الرقم الجامعي"')
    .maybeSingle();
  if (updateError || !updatedStudent) {
    if (updateError) console.error('[first-login-verify] password update failed:', updateError.message);
    return NextResponse.json({ success: false, error: 'first-login-password-update-failed' }, { status: 500 });
  }

  const fullName = [
    studentRecord['اسم الطالب'],
    studentRecord['اسم الاب'] ?? studentRecord['اسم الأب'],
    studentRecord['الكنية'],
  ].map(clean).filter(Boolean).join(' ');
  let auditWarning = false;
  try {
    await writeServerAuditLog(request, {
      action: 'student_first_login_password_changed',
      userType: 'student',
      userId: canonicalStudentId,
      username: fullName,
      fullName,
    });
  } catch (auditError) {
    console.error('[first-login-verify] audit logging failed:', auditError);
    auditWarning = true;
  }

  return NextResponse.json({ success: true, auditWarning });
}
