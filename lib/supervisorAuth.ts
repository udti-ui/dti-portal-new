import 'server-only';
import { createSupabaseAdminClient } from './supabaseAdmin';

const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalized = (value: unknown) => clean(value).replace(/\s+/g, '').toLocaleLowerCase();

const firstDegreeValues = [
  '1', '١', 'one', 'first', 'firstdegree', 'اولى', 'الأولى', 'الدرجةالأولى', 'درجةالأولى',
  '1st', '1stdegree', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور',
];

const degreeFourValues = ['4', '٤', 'four', 'fourth', '4th', '4thdegree', 'degree4', 'level4', 'level4supervisor', 'رابعة', 'الرابعة', 'الدرجةالرابعة', 'درجةالرابعة', 'الدرجة4', 'درجة4', 'الدرجة٤', 'درجة٤'];

export const verifySupervisorCredentials = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const { data, error } = await supabase.from('المشرفين').select('*');
  if (error) return { valid: false, failed: true };

  const supervisor = (data ?? []).find((row) => {
    const record = row as Record<string, unknown>;
    const savedUsername = record['اسم المستخدم'] ?? record.username ?? record['اسم_المستخدم'] ?? record.user_name;
    const savedPassword = record['كلمة المرور'] ?? record['كلمة السر'] ?? record['كلمة_المرور'] ?? record.password ?? record.pass;
    return normalized(savedUsername) === normalized(username) && clean(savedPassword) === password;
  }) as Record<string, unknown> | undefined;
  const degree = normalized(supervisor?.['الدرجة'] ?? supervisor?.degree ?? supervisor?.rank ?? supervisor?.role ?? supervisor?.level);
  return { valid: Boolean(supervisor), failed: false, degree, supervisor };
};

export const verifyFirstDegreeSupervisor = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const verification = await verifySupervisorCredentials(supabase, username, password);
  return {
    valid: verification.valid && firstDegreeValues.includes(verification.degree ?? ''),
    failed: verification.failed,
  };
};

export const verifyDegreeFourSupervisor = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const verification = await verifySupervisorCredentials(supabase, username, password);
  const degree = verification.degree ?? '';
  const isDegreeFour = degreeFourValues.includes(degree)
    || degree.includes('رابعة')
    || /(?:^|\D)4(?:\D|$)/.test(degree);
  if (verification.failed || isDegreeFour) {
    return { valid: verification.valid && isDegreeFour, failed: verification.failed };
  }

  const { data: student, error: studentError } = await supabase.from('students').select('*')
    .eq('الرقم الجامعي', username).maybeSingle();
  if (studentError) return { valid: false, failed: true };
  if (!student) return { valid: false, failed: false };
  const studentRecord = student as Record<string, unknown>;
  const studentPassword = clean(studentRecord['كلمة السر'] ?? studentRecord.password ?? studentRecord.pass);
  if (studentPassword !== password) return { valid: false, failed: false };

  const { data: supportRole, error: supportRoleError } = await supabase.from('student_chat_support_staff')
    .select('student_id').eq('student_id', username).eq('is_active', true).maybeSingle();
  if (supportRoleError) return { valid: false, failed: true };
  return {
    valid: Boolean(supportRole),
    failed: false,
  };
};
