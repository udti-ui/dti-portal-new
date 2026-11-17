import { NextResponse } from 'next/server';
import { writeServerAuditLog } from '../../../../lib/auditLogServer';
import { buildClassChangeEmail, sendEmail } from '../../../../lib/email';
import { buildStudentTelegramMessage, sendTelegramNotification } from '../../../../lib/telegram';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type ClassChangeRequest = {
  studentId?: string;
  password?: string;
  nextClass?: string;
};

export async function POST(request: Request) {
  try {
    const supabase = createSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'student-portal-server-key-missing' }, { status: 503 });
    }
    const body = await request.json() as ClassChangeRequest;
    const studentId = String(body.studentId ?? '').trim();
    const password = String(body.password ?? '');
    const nextClass = String(body.nextClass ?? '').trim();

    if (!studentId || !password || !nextClass) {
      return NextResponse.json({ success: false, error: 'missing-class-or-student' }, { status: 400 });
    }

    const { data: student, error: studentError } = await supabase.from('students')
      .select('"كلمة السر", "الفئة", "السنه الدراسية", "اسم الطالب", "اسم الاب", "الكنية", "البريد الإلكتروني", telegram_notifications_enabled, telegram_chat_id')
      .eq('الرقم الجامعي', studentId).maybeSingle();
    if (studentError) return NextResponse.json({ success: false, error: 'student-lookup-failed' }, { status: 500 });
    if (!student || String(student['كلمة السر'] ?? '') !== password) {
      return NextResponse.json({ success: false, error: 'student-not-found' }, { status: 404 });
    }

    const previousClass = String(student['الفئة'] ?? '').trim();
    const studentYear = normalizeYear(student['السنه الدراسية']);
    if (!studentYear) return NextResponse.json({ success: false, error: 'student-year-missing' }, { status: 400 });
    const { data: availableClasses, error: classesError } = await supabase.from('student_classes')
      .select('name, capacity').eq('student_year', studentYear);
    if (classesError) return NextResponse.json({ success: false, error: 'student-classes-load-failed' }, { status: 500 });
    const selectedClass = (availableClasses ?? []).find((item) => normalizeClass(item.name) === normalizeClass(nextClass));
    if (!selectedClass) return NextResponse.json({ success: false, error: 'class-not-available-for-student-year' }, { status: 400 });

    if (typeof selectedClass.capacity === 'number') {
      const { count: occupied, error: studentsError } = await supabase.from('students')
        .select('"الرقم الجامعي"', { count: 'exact', head: true })
        .eq('السنه الدراسية', studentYear)
        .eq('الفئة', selectedClass.name);
      if (studentsError) return NextResponse.json({ success: false, error: 'student-classes-load-failed' }, { status: 500 });
      if ((occupied ?? 0) >= selectedClass.capacity) return NextResponse.json({ success: false, error: 'class-full' }, { status: 400 });
    }
    const changedAt = new Date().toISOString();
    const { error: updateError } = await supabase.from('students').update({
      'الفئة': nextClass,
      'تاريخ_تغيير_الفئة': changedAt,
    }).eq('الرقم الجامعي', studentId);
    if (updateError) return NextResponse.json({ success: false, error: 'student-update-failed' }, { status: 500 });

    const studentName = [
      student['اسم الطالب'],
      student['اسم الاب'],
      student['الكنية'],
    ].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ') || 'الطالب';
    let auditLogged = true;
    try {
      await writeServerAuditLog(request, {
        action: 'student_class_changed',
        userType: 'student',
        userId: studentId,
        username: studentName,
        fullName: studentName,
        details: {
          studentId,
          studentName,
          year: String(student['السنه الدراسية'] ?? ''),
          previousClass,
          nextClass,
          changedAt,
        },
      });
    } catch (error) {
      auditLogged = false;
      console.error('[student-class-change] audit log insert failed:', error);
    }

    const email = String(student['البريد الإلكتروني'] ?? '').trim();
    const notificationsEnabled = Boolean(student.telegram_notifications_enabled);
    const chatId = String(student.telegram_chat_id ?? '').trim();

    // البريد وتيليجرام مستقلان، فنرسلهما معًا بدل الانتظار لكل واحد على حدة.
    const sendClassChangeEmail = async () => email
      ? sendEmail({
        to: email,
        subject: 'تغيير الفئة',
        html: buildClassChangeEmail({ studentName, previousClass, nextClass }),
      })
      : { success: false, error: 'student-email-missing' };

    const sendClassChangeTelegram = async (): Promise<{ ok?: boolean; status?: string }> => {
      if (!notificationsEnabled || !chatId) return { status: 'disabled_or_missing_chat_id' };
      const telegramMessage = buildStudentTelegramMessage({
        studentName,
        studentId,
        studentYear: String(student['السنه الدراسية'] ?? 'غير محدد'),
        studentClass: nextClass,
        statusText: `تم تغيير الفئة بنجاح من ${previousClass || 'غير محددة'} إلى ${nextClass}.`,
        title: 'تغيير الفئة',
      });
      return sendTelegramNotification(telegramMessage, { chatId, enabled: true });
    };

    const [emailResult, telegramResult] = await Promise.all([
      sendClassChangeEmail().catch((error) => {
        console.error('Class change email failed:', error);
        return { success: false, error: 'email-send-failed' };
      }),
      sendClassChangeTelegram().catch((error) => {
        console.error('Class change telegram failed:', error);
        return { ok: false, status: 'telegram_send_failed' };
      }),
    ]);

    return NextResponse.json({
      success: true,
      emailSent: emailResult.success,
      telegramSent: telegramResult.ok === true,
      auditLogged,
    });
  } catch (error) {
    console.error('Class change API failed:', error);
    return NextResponse.json({ success: false, error: 'class-change-failed' }, { status: 500 });
  }
}

const normalizeYear = (value: unknown): 'أولى' | 'ثانية' | '' => {
  const year = String(value ?? '').trim().replace(/\s+/g, '').toLocaleLowerCase();
  if (['1', '١'].includes(year) || year.includes('اولى') || year.includes('أولى') || year.includes('first')) return 'أولى';
  if (['2', '٢'].includes(year) || year.includes('ثانية') || year.includes('second')) return 'ثانية';
  return '';
};

const normalizeClass = (value: unknown) => String(value ?? '').trim().replace(/^فئة\s*/, '').replace(/\s+/g, '');
