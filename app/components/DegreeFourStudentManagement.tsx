'use client';

import Image from 'next/image';
import { ChangeEvent, FormEvent, MouseEvent, useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { writeAuditLog } from '../../lib/auditLog';

type Props = {
  supervisorUsername: string;
  supervisorPassword: string;
  supervisorDegree: string;
};

type AccountSummary = {
  studentId: string;
  name: string;
  phone: string;
  year: string;
  createdAt: string;
  canDelete: boolean;
  canEdit: boolean;
};

type SearchStudent = { studentId: string; name: string; phone: string; year?: string; className?: string };
type ClassOption = { name: string; capacity: number; occupied: number; available: number };
type StudentEdit = {
  studentId: string;
  name: string;
  phone: string;
  email: string;
  registrationType: string;
  telegramCode: string;
  fields: Record<string, string>;
};
type Ticket = {
  id: string;
  ticket_type: 'general' | 'student_update';
  student_id: string | null;
  requester_username: string;
  description: string;
  requested_changes: Record<string, string>;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
};
type ApiResult = {
  success?: boolean;
  error?: string;
  message?: string;
  existingName?: string | null;
  suggestedId?: string;
  exists?: boolean;
  studentId?: string;
  year?: string;
  className?: string;
  forcePasswordChange?: boolean;
  accounts?: AccountSummary[];
  students?: SearchStudent[];
  classes?: ClassOption[];
  student?: StudentEdit;
  tickets?: Ticket[];
};

const registrations = ['عام', 'موازي', 'عرب أجانب', 'أبناء مدرسين', 'ذوي احتياجات'];
const departments = ['تعويضات أسنان', 'مساعد طبيب أسنان'];
const studentFields = [
  { key: 'اسم الطالب', label: 'اسم الطالب' },
  { key: 'اسم الاب', label: 'اسم الأب' },
  { key: 'الكنية', label: 'الكنية' },
  { key: 'رقم الهاتف', label: 'رقم الهاتف' },
  { key: 'البريد الإلكتروني', label: 'البريد الإلكتروني' },
  { key: 'نوع التسجيل', label: 'نوع التسجيل' },
  { key: 'القسم', label: 'القسم' },
  { key: 'الفئة', label: 'الفئة / الشعبة' },
  { key: 'السنه الدراسية', label: 'السنة الدراسية' },
  { key: 'telegram_verification_code', label: 'كود تحقق تلجرام' },
] as const;
const errorMessages: Record<string, string> = {
  'student-id-already-exists': 'الرقم الجامعي مستخدم مسبقاً.',
  'degree-four-supervisor-required': 'هذه الوظيفة متاحة لمشرفي الدرجة الرابعة فقط.',
  'first-degree-supervisor-required': 'مراجعة التذاكر متاحة للإدارة العليا فقط.',
  'student-delete-window-expired': 'انتهت مهلة حذف الحساب (24 ساعة من إنشائه).',
  'student-edit-window-expired': 'انتهت مهلة التعديل المباشر (48 ساعة). يمكنك رفع طلب للإدارة العليا.',
  'created-student-not-found': 'الحساب غير موجود ضمن الحسابات التي أنشأتها.',
  'ticket-already-reviewed': 'تمت مراجعة هذا الطلب مسبقاً.',
  'student-class-unavailable': 'الفئة المختارة لا تتوفر فيها مقاعد حالياً. اختر فئة أخرى.',
  'student-classes-load-failed': 'تعذر تحميل الفئات المتاحة. حاول تحديث الصفحة.',
};
const normalizePhone = (value: string) => value
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  .replace(/\s+/g, '')
  .replace(/^0+/, '');

export default function DegreeFourStudentManagement({
  supervisorUsername,
  supervisorPassword,
  supervisorDegree,
}: Props) {
  const isReviewer = supervisorDegree === '1';
  const [notice, setNotice] = useState('');
  const [errorNotice, setErrorNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggestedId, setSuggestedId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [duplicateName, setDuplicateName] = useState('');
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [availableClasses, setAvailableClasses] = useState<ClassOption[]>([]);
  const [selectedStudentClasses, setSelectedStudentClasses] = useState<ClassOption[]>([]);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<SearchStudent[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<SearchStudent | null>(null);
  const [editStudent, setEditStudent] = useState<StudentEdit | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [requestedField, setRequestedField] = useState<string>('رقم الهاتف');
  const [requestedValue, setRequestedValue] = useState('');
  const [requestDescription, setRequestDescription] = useState('');
  const [ticketDescription, setTicketDescription] = useState('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [registrationType, setRegistrationType] = useState('عام');
  const [year, setYear] = useState('أولى');
  const [avatar, setAvatar] = useState('');
  const [telegramQr, setTelegramQr] = useState('');
  const [form, setForm] = useState({
    password: '',
    name: '',
    fatherName: '',
    surname: '',
    section: 'تعويضات أسنان',
    className: '',
    phone: '',
    email: '',
    telegramCode: '',
  });

  const request = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch('/api/supervisor/student-operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        supervisorUsername,
        supervisorPassword,
        ...extra,
      }),
    });
    const result = await response.json() as ApiResult;
    if (!response.ok || !result.success) {
      const message = result.error === 'student-id-already-exists' && result.existingName
        ? `الرقم الجامعي مستخدم من قبل الطالب: ${result.existingName}`
        : result.error ? errorMessages[result.error] || result.error : 'تعذر تنفيذ الطلب.';
      throw new Error(message);
    }
    return result;
  }, [supervisorPassword, supervisorUsername]);

  const showError = (error: unknown) => {
    setErrorNotice(true);
    setNotice(error instanceof Error ? error.message : 'تعذر تنفيذ العملية.');
  };
  const showSuccess = (message: string) => {
    setErrorNotice(false);
    setNotice(message);
  };
  const logButtonClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button');
    if (!button) return;
    writeAuditLog({
      action: 'supervisor_button_clicked',
      userType: isReviewer ? 'supervisor' : 'support_supervisor',
      username: supervisorUsername,
      fullName: supervisorUsername,
      details: {
        feature: isReviewer ? 'support_tickets' : 'degree4_students',
        button: (button.getAttribute('aria-label') || button.innerText || 'button').trim().slice(0, 120),
      },
    });
  };

  const refreshAccounts = useCallback(async () => {
    const result = await request('my-accounts');
    setAccounts(result.accounts ?? []);
  }, [request]);

  const refreshSuggestion = useCallback(async (force = false) => {
    const result = await request('initial');
    setSuggestedId(result.suggestedId ?? '');
    setStudentId((current) => force || !current ? result.suggestedId || '' : current);
  }, [request]);

  const refreshTickets = useCallback(async () => {
    const result = await request('list-tickets');
    setTickets(result.tickets ?? []);
  }, [request]);

  const refreshAvailableClasses = useCallback(async (targetYear: string) => {
    const result = await request('available-classes', { year: targetYear });
    setAvailableClasses(result.classes ?? []);
  }, [request]);

  const refreshSelectedStudentClasses = useCallback(async (targetYear: string) => {
    const result = await request('available-classes', { year: targetYear });
    setSelectedStudentClasses(result.classes ?? []);
  }, [request]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setBusy(true);
      try {
        if (isReviewer) {
          const result = await request('list-tickets');
          if (active) setTickets(result.tickets ?? []);
        } else {
          const [numberResult, accountResult, qr] = await Promise.all([
            request('initial'),
            request('my-accounts'),
            QRCode.toDataURL('https://t.me/DTI_Portal_Bot', { width: 220, margin: 2 }),
          ]);
          if (!active) return;
          setSuggestedId(numberResult.suggestedId ?? '');
          setStudentId(numberResult.suggestedId ?? '');
          setAccounts(accountResult.accounts ?? []);
          setTelegramQr(qr);
        }
      } catch (error) {
        if (active) showError(error);
      } finally {
        if (active) setBusy(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [isReviewer, request]);

  useEffect(() => {
    if (isReviewer) return;
    let active = true;
    void refreshAvailableClasses(year).catch((error: unknown) => {
      if (active) showError(error);
    });
    return () => { active = false; };
  }, [isReviewer, refreshAvailableClasses, year]);

  useEffect(() => {
    setForm((current) => current.className && !availableClasses.some((item) => item.name === current.className)
      ? { ...current, className: '' }
      : current);
  }, [availableClasses]);

  const checkStudentId = async () => {
    try {
      const result = await request('check-id', { studentId });
      setDuplicateName(result.exists ? result.existingName ?? 'طالب مسجل' : '');
      showSuccess(result.exists
        ? `الرقم مستخدم من قبل الطالب: ${result.existingName || 'اسم غير متوفر'}`
        : 'الرقم الجامعي غير مستخدم.');
    } catch (error) {
      showError(error);
    }
  };

  const handleAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      setAvatar('');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setErrorNotice(true);
      setNotice('الصورة يجب أن تكون JPG أو PNG أو WebP وبحجم لا يتجاوز 2 ميغابايت.');
      event.target.value = '';
      setAvatar('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result ?? ''));
    reader.onerror = () => showError(new Error('تعذر قراءة الصورة المحددة.'));
    reader.readAsDataURL(file);
  };

  const createAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (duplicateName) {
      showError(new Error(`الرقم مستخدم من قبل الطالب ${duplicateName}.`));
      return;
    }
    if (!window.confirm('أنت تتحمل كامل المسؤولية عن صحة ودقة البيانات التي تدخلها لهذا الطالب. هل تؤكد إنشاء الحساب؟')) return;
    setBusy(true);
    try {
      const result = await request('create', {
        student: {
          'الرقم الجامعي': studentId,
          'كلمة السر': form.password,
          'اسم الطالب': form.name,
          'اسم الاب': form.fatherName,
          'الكنية': form.surname,
          'القسم': form.section,
          'الفئة': form.className,
          'السنه الدراسية': year,
          'رقم الهاتف': form.phone,
          'البريد الإلكتروني': form.email,
          'نوع التسجيل': registrationType,
          telegram_verification_code: form.telegramCode,
        },
        avatar,
      });
      setDuplicateName('');
      setAvatar('');
      setForm({
        password: '',
        name: '',
        fatherName: '',
        surname: '',
        section: 'تعويضات أسنان',
        className: '',
        phone: '',
        email: '',
        telegramCode: '',
      });
      await Promise.all([refreshAccounts(), refreshSuggestion(true)]);
      showSuccess(result.forcePasswordChange
        ? `تم إنشاء الحساب ${result.studentId}. يجب على الطالب تغيير كلمة المرور عند أول دخول.`
        : `تم إنشاء الحساب ${result.studentId} بنجاح.`);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const searchStudents = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.confirm('تنبيه: عملية البحث عن الطلاب مسجلة ويمكن للإدارة العليا الرجوع إليها. هل تريد المتابعة؟')) return;
    setBusy(true);
    setSelectedStudent(null);
    setEditStudent(null);
    try {
      const result = await request('search', { query: searchText });
      setSearchResults(result.students ?? []);
      showSuccess(`اكتمل البحث. عدد النتائج: ${result.students?.length ?? 0}. تم تسجيل عملية البحث ويمكن للإدارة العليا مراجعتها.`);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const selectStudent = async (student: SearchStudent) => {
    setEditStudent(null);
    setSelectedStudentClasses([]);
    try {
      const result = await request('select-student', { studentId: student.studentId });
      const selected = { ...student, year: result.year, className: result.className };
      setSelectedStudent(selected);
      setRequestedValue('');
      setRequestDescription('');
      if (result.year === 'أولى' || result.year === 'ثانية') await refreshSelectedStudentClasses(result.year);
    } catch (error) {
      showError(error);
    }
  };

  const openOwnAccount = async (account: AccountSummary) => {
    setSelectedStudent({ studentId: account.studentId, name: account.name, phone: account.phone, year: account.year });
    setEditStudent(null);
    setSelectedStudentClasses([]);
    try {
      const selected = await request('select-student', { studentId: account.studentId });
      if (selected.year === 'أولى' || selected.year === 'ثانية') {
        await refreshSelectedStudentClasses(selected.year);
      }
    } catch (error) {
      showError(error);
      return;
    }
    if (!account.canEdit) return;
    try {
      const result = await request('get-owned-account', { studentId: account.studentId });
      if (!result.student) return;
      setEditStudent(result.student);
      setEditValues(result.student.fields);
      if (result.student.fields['السنه الدراسية']) {
        await refreshSelectedStudentClasses(result.student.fields['السنه الدراسية']);
      }
    } catch (error) {
      showError(error);
    }
  };

  const submitDirectEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editStudent) return;
    const changes = Object.fromEntries(Object.entries(editValues)
      .filter(([key, value]) => value !== (editStudent.fields[key] ?? '')));
    setBusy(true);
    try {
      await request('edit', { studentId: editStudent.studentId, changes });
      await refreshAccounts();
      setEditStudent(null);
      showSuccess('تم حفظ التعديلات على حساب الطالب.');
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (account: AccountSummary) => {
    if (!window.confirm(`هل تريد حذف حساب ${account.name} (${account.studentId}) نهائياً؟`)) return;
    setBusy(true);
    try {
      await request('delete', { studentId: account.studentId });
      await refreshAccounts();
      if (selectedStudent?.studentId === account.studentId) setSelectedStudent(null);
      showSuccess('تم حذف الحساب الذي أنشأته.');
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const submitUpdateRequest = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedStudent) return;
    setBusy(true);
    try {
      await request('request-update', {
        studentId: selectedStudent.studentId,
        description: requestDescription,
        changes: { [requestedField]: requestedValue },
      });
      setRequestDescription('');
      setRequestedValue('');
      showSuccess('تم رفع طلب التعديل للإدارة العليا، ولن يُحفظ التعديل قبل الموافقة.');
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const submitGeneralTicket = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await request('create-ticket', { description: ticketDescription });
      setTicketDescription('');
      showSuccess('تم رفع التذكرة إلى الإدارة العليا.');
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const reviewTicket = async (ticket: Ticket, decision: 'approved' | 'rejected') => {
    setBusy(true);
    try {
      await request('review-ticket', { ticketId: ticket.id, decision });
      await refreshTickets();
      showSuccess(decision === 'approved'
        ? 'تمت الموافقة وحفظ التعديل على حساب الطالب.'
        : 'تم رفض الطلب ولم يُحفظ أي تعديل.');
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  if (isReviewer) {
    return (
      <section className="admin-dashboard-panel degree4-support-panel" onClickCapture={logButtonClick}>
        <div className="admin-dashboard-heading">
          <div>
            <span className="feature-panel-kicker">الإدارة العليا</span>
            <h1>تذاكر مشرفي الدرجة الرابعة</h1>
            <p>الموافقة على طلبات تعديل الطلاب تحفظ البيانات فوراً، والرفض لا يغيّر بيانات الطالب.</p>
          </div>
          <button type="button" className="action-button primary" onClick={() => void refreshTickets()} disabled={busy}>تحديث التذاكر</button>
        </div>
        {notice && <p role="status" className={errorNotice ? 'form-error' : 'form-success'}>{notice}</p>}
        {tickets.length === 0 ? <p>لا توجد تذاكر حالياً.</p> : tickets.map((ticket) => (
          <article className="admin-record-item degree4-ticket-card" key={ticket.id}>
            <strong>{ticket.ticket_type === 'student_update' ? `طلب تعديل طالب ${ticket.student_id ?? ''}` : 'تذكرة دعم عامة'}</strong>
            <span>المشرف: {ticket.requester_username} - {new Date(ticket.created_at).toLocaleString('ar')}</span>
            <span>الحالة: {ticket.status === 'pending' ? 'بانتظار المراجعة' : ticket.status === 'approved' ? 'مقبولة' : 'مرفوضة'}</span>
            <span>{ticket.description}</span>
            {ticket.ticket_type === 'student_update' && (
              <span>التعديلات المطلوبة: {Object.entries(ticket.requested_changes ?? {}).map(([key, value]) => `${key}: ${value}`).join('، ')}</span>
            )}
            {ticket.status === 'pending' && (
              <div className="admin-record-actions">
                <button type="button" className="action-button primary" disabled={busy} onClick={() => void reviewTicket(ticket, 'approved')}>موافقة وحفظ</button>
                <button type="button" className="action-button danger" disabled={busy} onClick={() => void reviewTicket(ticket, 'rejected')}>رفض</button>
              </div>
            )}
          </article>
        ))}
      </section>
    );
  }

  return (
    <section className="admin-dashboard-panel degree4-support-panel" onClickCapture={logButtonClick}>
      <div className="admin-dashboard-heading">
        <div>
          <span className="feature-panel-kicker">خدمات مشرف الدرجة الرابعة</span>
          <h1>إنشاء وإدارة حسابات الطلاب</h1>
          <p>عدد الحسابات التي أنشأتها: <strong>{accounts.length}</strong></p>
        </div>
        <button type="button" className="action-button primary" onClick={() => void refreshAccounts()} disabled={busy}>تحديث الحسابات</button>
      </div>
      {notice && <p role="status" className={errorNotice ? 'form-error' : 'form-success'}>{notice}</p>}

      <form className="degree4-student-form" onSubmit={(event) => void createAccount(event)}>
        <section className="degree4-form-section">
          <h2>بيانات الحساب</h2>
          <div className="degree4-form-grid">
            <label className="degree4-field">
              <span>الرقم الجامعي <small>(4 أرقام على الأقل)</small></span>
              <div className="degree4-number-control">
                <input id="degree4-student-id" inputMode="numeric" minLength={4} pattern="[0-9٠-٩]{4,}" required value={studentId} onChange={(event) => { setStudentId(event.target.value); setDuplicateName(''); }} />
                <button type="button" className="action-button" onClick={() => void checkStudentId()} disabled={busy}>تحقق</button>
              </div>
              <small>المقترح التالي: {suggestedId || 'جارٍ التحميل'}</small>
              {duplicateName && <small className="form-error">الرقم مستخدم من قبل: {duplicateName}</small>}
            </label>
            <label className="degree4-field">
              <span>كلمة المرور الأولية</span>
              <input type="password" autoComplete="new-password" required minLength={6} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </label>
            <label className="degree4-field">
              <span>السنة الدراسية</span>
              <select value={year} onChange={(event) => { setYear(event.target.value); setForm((current) => ({ ...current, className: '' })); }}>
                <option value="أولى">السنة الأولى</option>
                <option value="ثانية">السنة الثانية</option>
              </select>
            </label>
            <label className="degree4-field"><span>اسم الطالب</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label className="degree4-field"><span>اسم الأب</span><input required value={form.fatherName} onChange={(event) => setForm({ ...form, fatherName: event.target.value })} /></label>
            <label className="degree4-field"><span>الكنية</span><input required value={form.surname} onChange={(event) => setForm({ ...form, surname: event.target.value })} /></label>
            <label className="degree4-field">
              <span>القسم</span>
              <select required value={form.section} onChange={(event) => setForm({ ...form, section: event.target.value })}>
                {departments.map((department) => <option key={department} value={department}>قسم {department}</option>)}
              </select>
            </label>
            <label className="degree4-field">
              <span>الفئة <small>(اختياري، الفئات ذات المقاعد المتاحة فقط)</small></span>
              <select value={form.className} onChange={(event) => setForm({ ...form, className: event.target.value })} disabled={availableClasses.length === 0}>
                <option value="">{availableClasses.length ? 'بدون فئة' : 'لا توجد فئات بمقاعد متاحة'}</option>
                {availableClasses.map((item) => <option key={item.name} value={item.name}>{item.name} — متبقي {item.available}</option>)}
              </select>
            </label>
            <label className="degree4-field">
              <span>نوع التسجيل</span>
              <select value={registrationType} onChange={(event) => setRegistrationType(event.target.value)}>
                {registrations.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="degree4-field"><span>رقم الموبايل <small>(يحفظ دون صفر في البداية)</small></span><input type="tel" required value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} onBlur={() => setForm((current) => ({ ...current, phone: normalizePhone(current.phone) }))} /></label>
            <label className="degree4-field"><span>البريد الإلكتروني</span><input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
            <label className="degree4-field"><span>كود تحقق تلجرام <small>(اختياري)</small></span><input value={form.telegramCode} onChange={(event) => setForm({ ...form, telegramCode: event.target.value })} /></label>
            <label className="degree4-field degree4-field-wide">
              <span>الصورة الشخصية <small>(اختياري، حتى 2 ميغابايت)</small></span>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleAvatar} />
            </label>
          </div>
          <div className="degree4-form-footer">
            <p>بإنشاء الحساب، تؤكد تحملك مسؤولية صحة ودقة بيانات الطالب.</p>
            <button type="submit" className="action-button primary" disabled={busy}>{busy ? 'جارٍ الحفظ...' : 'إنشاء حساب الطالب'}</button>
          </div>
        </section>
      </form>

      <aside className="admin-record-item degree4-telegram-card">
        <strong>باركود بوت تلجرام</strong>
        <p>يمكن للطالب فتح البوت وربط حسابه لإعداد التنبيهات.</p>
        {telegramQr && <Image src={telegramQr} width={220} height={220} alt="باركود بوت المعهد على تلجرام" unoptimized />}
        <a href="https://t.me/DTI_Portal_Bot" target="_blank" rel="noreferrer">فتح بوت المعهد</a>
      </aside>

      <section className="admin-table-section degree4-section">
        <h2>الحسابات التي أنشأتها ({accounts.length})</h2>
        {accounts.length === 0 ? <p>لم تنشئ أي حساب بعد.</p> : <div className="degree4-account-list">{accounts.map((account) => (
          <article className="admin-record-item degree4-account-card" key={account.studentId}>
            <button type="button" className="action-button" onClick={() => void openOwnAccount(account)}>
              {account.name} - {account.studentId}
            </button>
            <span>الهاتف: {account.phone} - السنة: {account.year}</span>
            <span>تاريخ الإنشاء: {account.createdAt ? new Date(account.createdAt).toLocaleString('ar') : 'غير متوفر'}</span>
            <div className="admin-record-actions">
              {account.canEdit && <button type="button" className="action-button primary" onClick={() => void openOwnAccount(account)}>تعديل خلال 48 ساعة</button>}
              {account.canDelete && <button type="button" className="action-button danger" onClick={() => void deleteAccount(account)}>حذف خلال 24 ساعة</button>}
            </div>
          </article>
        ))}</div>}
      </section>

      {editStudent && (
        <form className="admin-supervisor-form degree4-edit-form" onSubmit={(event) => void submitDirectEdit(event)}>
          <h2>تعديل حساب {editStudent.name}</h2>
          <p>التعديل المباشر متاح خلال أول 48 ساعة من إنشاء الحساب.</p>
          <input value={editValues['اسم الطالب'] ?? ''} onChange={(event) => setEditValues({ ...editValues, 'اسم الطالب': event.target.value })} placeholder="اسم الطالب" />
          <input value={editValues['اسم الاب'] ?? ''} onChange={(event) => setEditValues({ ...editValues, 'اسم الاب': event.target.value })} placeholder="اسم الأب" />
          <input value={editValues['الكنية'] ?? ''} onChange={(event) => setEditValues({ ...editValues, 'الكنية': event.target.value })} placeholder="الكنية" />
          <input value={editValues['رقم الهاتف'] ?? ''} onChange={(event) => setEditValues({ ...editValues, 'رقم الهاتف': event.target.value })} onBlur={() => setEditValues((current) => ({ ...current, 'رقم الهاتف': normalizePhone(current['رقم الهاتف'] ?? '') }))} placeholder="رقم الهاتف (دون صفر البداية)" />
          <input type="email" value={editValues['البريد الإلكتروني'] ?? ''} onChange={(event) => setEditValues({ ...editValues, 'البريد الإلكتروني': event.target.value })} placeholder="البريد الإلكتروني" />
          <select value={editValues['نوع التسجيل'] ?? 'عام'} onChange={(event) => setEditValues({ ...editValues, 'نوع التسجيل': event.target.value })}>
            {registrations.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select value={editValues['القسم'] ?? departments[0]} onChange={(event) => setEditValues({ ...editValues, 'القسم': event.target.value })}>
            {departments.map((department) => <option key={department} value={department}>قسم {department}</option>)}
          </select>
          <select value={editValues['الفئة'] ?? ''} onChange={(event) => setEditValues({ ...editValues, 'الفئة': event.target.value })}>
            <option value="">بدون فئة</option>
            {editValues['الفئة'] && !selectedStudentClasses.some((item) => item.name === editValues['الفئة']) && <option value={editValues['الفئة']}>{editValues['الفئة']} — غير متاحة للحجز الجديد</option>}
            {selectedStudentClasses.map((item) => <option key={item.name} value={item.name}>{item.name} — متبقي {item.available}</option>)}
          </select>
          <select value={editValues['السنه الدراسية'] ?? ''} onChange={(event) => {
            const nextYear = event.target.value;
            setEditValues({ ...editValues, 'السنه الدراسية': nextYear, 'الفئة': '' });
            if (nextYear === 'أولى' || nextYear === 'ثانية') void refreshSelectedStudentClasses(nextYear).catch(showError);
          }}>
            <option value="">اختر السنة</option>
            <option value="أولى">أولى</option>
            <option value="ثانية">ثانية</option>
          </select>
          <input value={editValues.telegram_verification_code ?? ''} onChange={(event) => setEditValues({ ...editValues, telegram_verification_code: event.target.value })} placeholder="كود تحقق تلجرام" />
          <div className="admin-record-actions">
            <button type="submit" className="action-button primary" disabled={busy}>حفظ التعديل</button>
            <button type="button" className="action-button" onClick={() => setEditStudent(null)}>إلغاء</button>
          </div>
        </form>
      )}

      <section className="admin-table-section">
        <h2>البحث في الطلاب</h2>
        <p>تظهر نتائج البحث الاسم ورقم الموبايل فقط. كل عملية بحث تُسجل ويمكن للإدارة العليا مراجعتها.</p>
        <form className="admin-record-actions degree4-search-form" onSubmit={(event) => void searchStudents(event)}>
          <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="ابحث بالاسم أو رقم الموبايل أو الرقم الجامعي" minLength={2} required />
          <button type="submit" className="action-button primary" disabled={busy}>بحث مسجل</button>
        </form>
        {searchResults.map((student) => (
          <button type="button" className="admin-record-item degree4-search-result" key={student.studentId} onClick={() => void selectStudent(student)}>
            <strong>{student.name}</strong>
            <span>رقم الموبايل: {student.phone || 'غير متوفر'}</span>
          </button>
        ))}
        {selectedStudent && (
          <article className="admin-record-item">
            <strong>{selectedStudent.name}</strong>
            <span>رقم الموبايل: {selectedStudent.phone || 'غير متوفر'}</span>
            <form className="admin-supervisor-form degree4-ticket-form" onSubmit={(event) => void submitUpdateRequest(event)}>
              <h3>طلب تعديل للإدارة العليا</h3>
              <p>لن تُحفظ البيانات المطلوبة إلا بعد موافقة الإدارة العليا.</p>
              <select value={requestedField} onChange={(event) => setRequestedField(event.target.value)}>
                {studentFields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
              </select>
              {requestedField === 'نوع التسجيل' ? (
                <select value={requestedValue} onChange={(event) => setRequestedValue(event.target.value)} required>
                  <option value="">اختر نوع التسجيل</option>
                  {registrations.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              ) : requestedField === 'السنه الدراسية' ? (
                <select value={requestedValue} onChange={(event) => setRequestedValue(event.target.value)} required>
                  <option value="">اختر السنة الدراسية</option>
                  <option value="أولى">أولى</option>
                  <option value="ثانية">ثانية</option>
                </select>
              ) : requestedField === 'القسم' ? (
                <select value={requestedValue} onChange={(event) => setRequestedValue(event.target.value)} required>
                  <option value="">اختر القسم</option>
                  {departments.map((department) => <option key={department} value={department}>قسم {department}</option>)}
                </select>
              ) : requestedField === 'الفئة' ? (
                <select value={requestedValue} onChange={(event) => setRequestedValue(event.target.value)} required>
                  <option value="">اختر فئة بمقاعد متاحة</option>
                  {selectedStudentClasses.map((item) => <option key={item.name} value={item.name}>{item.name} — متبقي {item.available}</option>)}
                </select>
              ) : (
                <input value={requestedValue} onChange={(event) => setRequestedValue(event.target.value)} placeholder="القيمة الجديدة" required />
              )}
              <textarea value={requestDescription} onChange={(event) => setRequestDescription(event.target.value)} placeholder="اشرح سبب ونوع التعديل المطلوب" minLength={3} required />
              <button type="submit" className="action-button primary" disabled={busy}>رفع طلب التعديل</button>
            </form>
          </article>
        )}
      </section>

      <section className="admin-table-section">
        <h2>تذكرة إلى الإدارة العليا</h2>
        <form className="admin-supervisor-form degree4-ticket-form" onSubmit={(event) => void submitGeneralTicket(event)}>
          <textarea value={ticketDescription} onChange={(event) => setTicketDescription(event.target.value)} placeholder="اكتب موضوع التذكرة وتفاصيلها" minLength={3} required />
          <button type="submit" className="action-button primary" disabled={busy}>رفع التذكرة</button>
        </form>
      </section>
    </section>
  );
}
