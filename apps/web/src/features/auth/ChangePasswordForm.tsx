import { FormEvent, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * تغيير كلمة المرور للمستخدم المسجل بالبريد (Supabase Auth).
 * يُستخدم أول مرة لتغيير كلمة المرور المؤقتة التي سلّمها مسؤول النظام.
 */
export function ChangePasswordForm() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  if (!supabase) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (password.length < 8) {
      setMessage({ kind: 'error', text: 'كلمة المرور يجب ألا تقل عن 8 أحرف.' });
      return;
    }
    if (password !== confirm) {
      setMessage({ kind: 'error', text: 'كلمتا المرور غير متطابقتين.' });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase!.auth.updateUser({ password });
      if (error) throw error;
      setPassword('');
      setConfirm('');
      setMessage({ kind: 'ok', text: 'تم تغيير كلمة المرور. استخدمها في الدخول القادم.' });
    } catch {
      setMessage({ kind: 'error', text: 'تعذر تغيير كلمة المرور. حاول مرة أخرى أو اطلب المساعدة من مسؤول النظام.' });
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn--secondary" style={{ marginTop: '0.75rem', width: '100%' }} onClick={() => setOpen(true)}>
        تغيير كلمة المرور
      </button>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} style={{ marginTop: '0.75rem', display: 'grid', gap: '0.5rem' }} aria-label="تغيير كلمة المرور">
      <label className="auth-field__label" htmlFor="new-password">كلمة المرور الجديدة</label>
      <input id="new-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} className="auth-field__input" />
      <label className="auth-field__label" htmlFor="confirm-password">تأكيد كلمة المرور</label>
      <input id="confirm-password" type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="auth-field__input" />
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ margin: 0, fontSize: '0.85rem', color: message.kind === 'error' ? '#b91c1c' : '#166534' }}>
          {message.text}
        </p>
      )}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? 'جاري الحفظ…' : 'حفظ كلمة المرور'}</button>
        <button type="button" className="btn btn--secondary" onClick={() => { setOpen(false); setMessage(null); }}>إلغاء</button>
      </div>
    </form>
  );
}
