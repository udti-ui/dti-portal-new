import { NextResponse } from 'next/server';
import { verifyFirstDegreeSupervisor } from '../../../../lib/supervisorAuth';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type StudentYear = 'أولى' | 'ثانية';
const clean = (value: unknown) => String(value ?? '').trim();
const errorResponse = (error: string, status: number, message?: string) => NextResponse.json({
  success: false,
  error,
  ...(message ? { message } : {}),
}, { status });
const validYear = (value: unknown): value is StudentYear => value === 'أولى' || value === 'ثانية';

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse('invalid-request', 400, 'تعذر قراءة الطلب.');
  }

  const username = clean(body.username);
  const password = clean(body.password);
  const action = clean(body.action);
  if (!username || !password) return errorResponse('supervisor-credentials-required', 400);
  if (action !== 'load' && action !== 'save') return errorResponse('invalid-action', 400);

  const supabase = createSupabaseAdminClient();
  if (!supabase) return errorResponse('supervisor-server-key-missing', 503, 'إعدادات خدمة قاعدة البيانات غير مكتملة.');
  const verification = await verifyFirstDegreeSupervisor(supabase, username, password);
  if (verification.failed) return errorResponse('supervisor-verification-failed', 500);
  if (!verification.valid) return errorResponse('supervisor-credentials-invalid', 401);

  if (action === 'load') {
    const { data, error } = await supabase.from('student_id_change_locks').select('student_year, is_open');
    if (error) {
      console.error('STUDENT_ID_CHANGE_LOCK_LOAD_FAILED:', error);
      return errorResponse('student-id-change-lock-load-failed', 500, error.message);
    }
    const locks: Record<StudentYear, boolean> = { 'أولى': true, 'ثانية': true };
    for (const row of data ?? []) {
      if (validYear(row.student_year)) locks[row.student_year] = row.is_open === true;
    }
    return NextResponse.json({ success: true, locks });
  }

  const studentYear = body.studentYear;
  const isOpen = body.isOpen;
  if (!validYear(studentYear) || typeof isOpen !== 'boolean') {
    return errorResponse('invalid-lock-setting', 400, 'حدد السنة وحالة فتح أو إغلاق التغيير.');
  }

  const { error } = await supabase.from('student_id_change_locks').upsert({
    student_year: studentYear,
    is_open: isOpen,
    updated_by: username,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'student_year' });
  if (error) {
    console.error('STUDENT_ID_CHANGE_LOCK_SAVE_FAILED:', error);
    return errorResponse('student-id-change-lock-save-failed', 500, error.message);
  }
  return NextResponse.json({ success: true, studentYear, isOpen });
}
