'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type SupportStaff = {
  student_id: string;
  student_name: string;
  granted_at: string;
  granted_by: string;
};

type Props = {
  supervisorUsername: string;
  supervisorPassword: string;
};

export default function SupportStaffManagement({ supervisorUsername, supervisorPassword }: Props) {
  const [studentId, setStudentId] = useState('');
  const [studentName, setStudentName] = useState('');
  const [staff, setStaff] = useState<SupportStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [hasError, setHasError] = useState(false);

  const request = useCallback(async (action: string, id?: string) => {
    const response = await fetch('/api/student-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        action,
        supervisorUsername,
        supervisorPassword,
        ...(id ? { studentId: id } : {}),
      }),
    });
    const result = await response.json() as {
      success?: boolean;
      error?: string;
      staff?: SupportStaff[];
      student?: { studentId: string; studentName: string };
    };
    if (!response.ok || !result.success) {
      const messages: Record<string, string> = {
        'first-degree-supervisor-required': 'إدارة صلاحيات قسم الدعم متاحة لمشرفي الدرجة الأولى فقط.',
        'student-not-found': 'لم يُعثر على طالب بهذا الرقم الجامعي.',
        'support-staff-load-failed': 'تعذر تحميل قائمة موظفي الدعم.',
        'support-staff-save-failed': 'تعذر حفظ صلاحية قسم الدعم.',
      };
      throw new Error(messages[result.error ?? ''] ?? 'تعذر تنفيذ الطلب.');
    }
    return result;
  }, [supervisorPassword, supervisorUsername]);

  const loadStaff = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request('support-staff-list');
      setStaff(result.staff ?? []);
      setHasError(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'تعذر تحميل القائمة.');
      setHasError(true);
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void loadStaff();
  }, [loadStaff]);

  const lookUpStudent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = studentId.trim();
    if (!id) return;
    setSaving(true);
    setNotice('');
    try {
      const result = await request('support-staff-lookup', id);
      setStudentName(result.student?.studentName ?? '');
      setNotice(`تم التحقق من الحساب: ${result.student?.studentName ?? ''}`);
      setHasError(false);
    } catch (error) {
      setStudentName('');
      setNotice(error instanceof Error ? error.message : 'تعذر التحقق من الحساب.');
      setHasError(true);
    } finally {
      setSaving(false);
    }
  };

  const grantAccess = async () => {
    const id = studentId.trim();
    if (!id || !studentName) return;
    setSaving(true);
    setNotice('');
    try {
      await request('grant-support-staff', id);
      setStudentId('');
      setStudentName('');
      setNotice('تم منح صلاحية قسم الدعم. يستطيع الطالب تسجيل الدخول إلى لوحة التحكم بحسابه.');
      setHasError(false);
      await loadStaff();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'تعذر منح الصلاحية.');
      setHasError(true);
    } finally {
      setSaving(false);
    }
  };

  const revokeAccess = async (id: string) => {
    setSaving(true);
    setNotice('');
    try {
      await request('revoke-support-staff', id);
      setNotice('تم سحب صلاحية قسم الدعم.');
      setHasError(false);
      await loadStaff();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'تعذر سحب الصلاحية.');
      setHasError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="admin-dashboard-panel support-staff-management">
      <div className="admin-dashboard-heading">
        <div>
          <span className="feature-panel-kicker">صلاحيات الدردشة</span>
          <h1>إدارة موظفي قسم الدعم</h1>
          <p>امنح حساب طالب صلاحية متابعة دردشتي السنتين وكتم الطلاب عند الحاجة.</p>
        </div>
      </div>
      <form className="support-staff-grant-form" onSubmit={(event) => void lookUpStudent(event)}>
        <label>
          الرقم الجامعي للطالب
          <input value={studentId} onChange={(event) => {
            setStudentId(event.currentTarget.value);
            setStudentName('');
          }} inputMode="numeric" required />
        </label>
        <button type="submit" className="action-button" disabled={saving || !studentId.trim()}>
          {saving ? 'جارٍ التحقق...' : 'التحقق من الطالب'}
        </button>
        {studentName && (
          <div className="support-staff-student-confirmation">
            <span>الحساب المحدد</span>
            <strong>{studentName}</strong>
            <button type="button" className="action-button primary" onClick={() => void grantAccess()} disabled={saving}>
              منح صلاحية قسم الدعم
            </button>
          </div>
        )}
      </form>
      {notice && <p role={hasError ? 'alert' : 'status'} className={`teacher-account-notice ${hasError ? 'error' : 'success'}`}>{notice}</p>}
      <section aria-labelledby="support-staff-list-title">
        <h2 id="support-staff-list-title">الحسابات المخولة حاليًا</h2>
        {loading ? <div className="loading-box">جارٍ تحميل القائمة...</div> : staff.length ? (
          <div className="support-staff-list">
            {staff.map((member) => (
              <article key={member.student_id} className="support-staff-row">
                <div>
                  <strong>{member.student_name}</strong>
                  <span>الرقم الجامعي: {member.student_id}</span>
                  <span>مُنحت الصلاحية بواسطة: {member.granted_by}</span>
                </div>
                <button type="button" className="action-button danger" onClick={() => void revokeAccess(member.student_id)} disabled={saving}>
                  سحب الصلاحية
                </button>
              </article>
            ))}
          </div>
        ) : <p className="empty-state">لا يوجد حسابات مخولة حاليًا.</p>}
      </section>
    </section>
  );
}
