import React, { useState, useEffect } from 'react';
import {
  CatalogItemDetail,
  CatalogItemUpdateInput,
  CatalogItemRevision,
  CatalogApprovalHistory,
  ItemCategory,
  Unit,
  ApplicationLine,
  ClassificationStatus,
  getCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
  addItemUsage,
  removeItemUsage,
  submitItemForReview,
  approveCatalogItem,
  rejectCatalogItem,
  reopenCatalogItem,
  deactivateCatalogItem,
  reactivateCatalogItem,
  createItemRevision,
  approveItemRevision,
  rejectItemRevision,
  cancelItemRevision,
  fetchItemRevisions,
  fetchItemHistory,
} from './catalogApi';
import { ClassificationBadge } from './ClassificationBadge';
import { ApprovalStatusBadge } from './ApprovalStatusBadge';
import { ApiError } from '@/lib/api';

interface Props {
  itemId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onItemUpdated: () => void;
  categories: ItemCategory[];
  units: Unit[];
  allApplicationLines: ApplicationLine[];
}

const ITEM_TYPES: Array<{ value: string; label: string }> = [
  { value: 'fabric', label: 'أقمشة وخامات (Fabric)' },
  { value: 'accessory', label: 'إكسسوارات ومستلزمات حياكة (Accessory)' },
  { value: 'maintenance_supply', label: 'قطع غيار وصيانة (Maintenance Supply)' },
  { value: 'reusable_tool', label: 'أدوات ومعدات تشغيل (Reusable Tool)' },
  { value: 'packaging', label: 'مواد تعبئة وتغليف (Packaging)' },
  { value: 'finished_garment', label: 'منتج تام (Finished Garment)' },
];

export const ItemDetailDrawer: React.FC<Props> = ({
  itemId,
  isOpen,
  onClose,
  onItemUpdated,
  categories,
  units,
  allApplicationLines,
}) => {
  const [activeTab, setActiveTab] = useState<'details' | 'revisions' | 'history'>('details');
  const [item, setItem] = useState<CatalogItemDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Editable fields
  const [nameAr, setNameAr] = useState('');
  const [itemType, setItemType] = useState('fabric');
  const [categoryId, setCategoryId] = useState<string>('');
  const [unitId, setUnitId] = useState<string>('');
  const [status, setStatus] = useState<ClassificationStatus>('needs_review');
  const [isConsumable, setIsConsumable] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [reorderLevel, setReorderLevel] = useState<number>(0);

  // Dimension attributes
  const [widthCm, setWidthCm] = useState<string>('');
  const [weightGsm, setWeightGsm] = useState<string>('');
  const [lengthCm, setLengthCm] = useState<string>('');
  const [diameterMm, setDiameterMm] = useState<string>('');

  // Application usages
  const [selectedAppToAdd, setSelectedAppToAdd] = useState<string>('');
  const [usageLoading, setUsageLoading] = useState(false);

  // Revisions & History states
  const [revisions, setRevisions] = useState<CatalogItemRevision[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [history, setHistory] = useState<CatalogApprovalHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Modals / dialogs within drawer
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [revisionSummary, setRevisionSummary] = useState('');
  const [revProposedNameAr, setRevProposedNameAr] = useState('');
  const [revProposedCategoryId, setRevProposedCategoryId] = useState('');
  const [revProposedStatus, setRevProposedStatus] = useState<ClassificationStatus>('confirmed');
  const [revProposedWidth, setRevProposedWidth] = useState('');
  const [revProposedWeight, setRevProposedWeight] = useState('');
  const [revProposedLength, setRevProposedLength] = useState('');
  const [revProposedDiameter, setRevProposedDiameter] = useState('');

  // Revision action states
  const [revisionRejectId, setRevisionRejectId] = useState<string | null>(null);
  const [revisionRejectReason, setRevisionRejectReason] = useState('');

  const loadItemData = (id: string) => {
    setLoading(true);
    setError(null);
    getCatalogItem(id)
      .then((data) => {
        setItem(data);
        setNameAr(data.name_ar);
        setItemType(data.item_type);
        setCategoryId(data.category_id || '');
        setUnitId(data.unit_id);
        setStatus(data.classification_status);
        setIsConsumable(data.is_consumable);
        setIsActive(data.is_active);
        setReorderLevel(data.reorder_level || 0);

        const attrs = (data.attributes || {}) as Record<string, unknown>;
        setWidthCm(attrs.width_cm !== undefined && attrs.width_cm !== null ? String(attrs.width_cm) : '');
        setWeightGsm(attrs.weight_gsm !== undefined && attrs.weight_gsm !== null ? String(attrs.weight_gsm) : '');
        setLengthCm(attrs.length_cm !== undefined && attrs.length_cm !== null ? String(attrs.length_cm) : '');
        setDiameterMm(attrs.diameter_mm !== undefined && attrs.diameter_mm !== null ? String(attrs.diameter_mm) : '');

        // Pre-fill proposed revision form
        setRevProposedNameAr(data.name_ar);
        setRevProposedCategoryId(data.category_id || '');
        setRevProposedStatus(data.classification_status);
        setRevProposedWidth(attrs.width_cm !== undefined && attrs.width_cm !== null ? String(attrs.width_cm) : '');
        setRevProposedWeight(attrs.weight_gsm !== undefined && attrs.weight_gsm !== null ? String(attrs.weight_gsm) : '');
        setRevProposedLength(attrs.length_cm !== undefined && attrs.length_cm !== null ? String(attrs.length_cm) : '');
        setRevProposedDiameter(attrs.diameter_mm !== undefined && attrs.diameter_mm !== null ? String(attrs.diameter_mm) : '');
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'تعذر تحميل بيانات الصنف.');
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    if (!isOpen || !itemId) {
      setItem(null);
      setError(null);
      setSuccessMsg(null);
      setActiveTab('details');
      return;
    }
    loadItemData(itemId);
  }, [isOpen, itemId]);

  useEffect(() => {
    if (!isOpen || !itemId) return;
    if (activeTab === 'revisions') {
      setRevisionsLoading(true);
      fetchItemRevisions(itemId)
        .then(setRevisions)
        .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'تعذر تحميل المراجعات.'))
        .finally(() => setRevisionsLoading(false));
    } else if (activeTab === 'history') {
      setHistoryLoading(true);
      fetchItemHistory(itemId)
        .then(setHistory)
        .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'تعذر تحميل سجل التدقيق.'))
        .finally(() => setHistoryLoading(false));
    }
  }, [activeTab, isOpen, itemId]);

  if (!isOpen) return null;

  const isFinishedGood = item?.code.startsWith('FG-VAR-') ?? false;
  const isApproved = item?.approval_status === 'approved';
  const isPendingReview = item?.approval_status === 'pending_review';
  const isDraft = item?.approval_status === 'draft';
  const isRejected = item?.approval_status === 'rejected';
  const isGrandfatheredLegacy =
    isApproved && (!item?.approved_by || item?.classification_status === 'needs_review');

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item) return;

    if (isApproved) {
      setError('الصنف معتمد حالياً ومحمي من التعديل المباشر. يرجى استخدام زر (طلب تعديل الصنف).');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const attributesPayload: Record<string, unknown> = {
        ...(item.attributes || {}),
      };

      if (widthCm.trim()) attributesPayload.width_cm = parseFloat(widthCm);
      else delete attributesPayload.width_cm;

      if (weightGsm.trim()) attributesPayload.weight_gsm = parseFloat(weightGsm);
      else delete attributesPayload.weight_gsm;

      if (lengthCm.trim()) attributesPayload.length_cm = parseFloat(lengthCm);
      else delete attributesPayload.length_cm;

      if (diameterMm.trim()) attributesPayload.diameter_mm = parseFloat(diameterMm);
      else delete attributesPayload.diameter_mm;

      const payload: CatalogItemUpdateInput = {
        name_ar: nameAr.trim(),
        item_type: itemType,
        unit_id: unitId,
        category_id: categoryId ? categoryId : null,
        classification_status: status,
        attributes: attributesPayload,
        reorder_level: Math.max(0, Number(reorderLevel) || 0),
        is_consumable: isConsumable,
        is_active: isActive,
      };

      const updated = await updateCatalogItem(item.id, payload);
      setItem((prev) => (prev ? { ...prev, ...updated } : null));
      setSuccessMsg('تم حفظ بيانات الصنف بنجاح.');
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحديث بيانات الصنف.');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmitForReview = async () => {
    if (!item) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await submitItemForReview(item.id);
      setItem((prev) => (prev ? { ...prev, ...updated } : null));
      setSuccessMsg('تم تقديم الصنف للمراجعة والاعتماد بنجاح.');
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر تقديم الصنف للمراجعة.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!item) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await approveCatalogItem(item.id);
      setItem((prev) => (prev ? { ...prev, ...updated } : null));
      setSuccessMsg('تم اعتماد الصنف بنجاح وتفعيله تشغيلياً في النظام.');
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر اعتماد الصنف.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!item || !rejectReason.trim()) return;
    if (rejectReason.trim().length < 10) {
      setError('سبب الرفض يجب ألا يقل عن 10 أحرف.');
      return;
    }
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await rejectCatalogItem(item.id, rejectReason.trim());
      setItem((prev) => (prev ? { ...prev, ...updated } : null));
      setShowRejectModal(false);
      setRejectReason('');
      setSuccessMsg('تم تسجيل رفض الاعتماد مع توثيق السبب.');
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر رفض الصنف.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReopen = async () => {
    if (!item) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await reopenCatalogItem(item.id);
      setItem((prev) => (prev ? { ...prev, ...updated } : null));
      setSuccessMsg('تمت إعادة فتح الصنف كمسودة لتصحيح النواقص وإعادة التقديم.');
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر إعادة فتح الصنف.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleActive = async () => {
    if (!item) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = item.is_active
        ? await deactivateCatalogItem(item.id)
        : await reactivateCatalogItem(item.id);
      setItem((prev) => (prev ? { ...prev, ...updated } : null));
      setIsActive(updated.is_active);
      setSuccessMsg(updated.is_active ? 'تم تفعيل الصنف تشغيلياً.' : 'تم تعطيل الصنف من العمليات.');
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر تغيير حالة تفعيل الصنف.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item) return;
    if (revisionSummary.trim().length < 5) {
      setError('ملخص التعديل يجب ألا يقل عن 5 أحرف.');
      return;
    }

    const proposedAttrs: Record<string, unknown> = {
      ...(item.attributes || {}),
    };
    if (revProposedWidth.trim()) proposedAttrs.width_cm = parseFloat(revProposedWidth);
    if (revProposedWeight.trim()) proposedAttrs.weight_gsm = parseFloat(revProposedWeight);
    if (revProposedLength.trim()) proposedAttrs.length_cm = parseFloat(revProposedLength);
    if (revProposedDiameter.trim()) proposedAttrs.diameter_mm = parseFloat(revProposedDiameter);

    const proposedChanges: Record<string, unknown> = {};
    if (revProposedNameAr.trim() !== item.name_ar) {
      proposedChanges.name_ar = revProposedNameAr.trim();
    }
    if ((revProposedCategoryId || null) !== item.category_id) {
      proposedChanges.category_id = revProposedCategoryId ? revProposedCategoryId : null;
    }
    if (revProposedStatus !== item.classification_status) {
      proposedChanges.classification_status = revProposedStatus;
    }
    proposedChanges.attributes = proposedAttrs;

    setActionLoading(true);
    setError(null);
    try {
      await createItemRevision(item.id, {
        proposed_changes: proposedChanges,
        change_summary: revisionSummary.trim(),
      });
      setShowRevisionModal(false);
      setRevisionSummary('');
      setSuccessMsg('تم تقديم طلب التعديل بنجاح وهو الآن بانتظار المراجعة والاعتماد.');
      loadItemData(item.id);
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر تقديم طلب التعديل.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApproveRevision = async (revId: string) => {
    if (!item) return;
    setActionLoading(true);
    setError(null);
    try {
      await approveItemRevision(item.id, revId);
      setSuccessMsg('تم اعتماد طلب التعديل وتطبيقه ذرياً على الصنف الحي.');
      loadItemData(item.id);
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر اعتماد طلب التعديل.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectRevision = async () => {
    if (!item || !revisionRejectId || !revisionRejectReason.trim()) return;
    setActionLoading(true);
    setError(null);
    try {
      await rejectItemRevision(item.id, revisionRejectId, revisionRejectReason.trim());
      setRevisionRejectId(null);
      setRevisionRejectReason('');
      setSuccessMsg('تم تسجيل رفض طلب التعديل مع توثيق السبب.');
      loadItemData(item.id);
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر رفض طلب التعديل.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelRevision = async (revId: string) => {
    if (!item) return;
    setActionLoading(true);
    setError(null);
    try {
      await cancelItemRevision(item.id, revId);
      setSuccessMsg('تم إلغاء طلب التعديل.');
      loadItemData(item.id);
      onItemUpdated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر إلغاء طلب التعديل.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddUsage = async () => {
    if (!item || !selectedAppToAdd) return;
    setUsageLoading(true);
    setError(null);
    try {
      await addItemUsage(item.id, selectedAppToAdd);
      const app = allApplicationLines.find((a) => a.id === selectedAppToAdd);
      if (app) {
        setItem((prev) => (prev ? { ...prev, usages: [...prev.usages, app] } : null));
      }
      setSelectedAppToAdd('');
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر إضافة خط الاستخدام للصنف.');
    } finally {
      setUsageLoading(false);
    }
  };

  const handleRemoveUsage = async (appId: string) => {
    if (!item) return;
    setUsageLoading(true);
    setError(null);
    try {
      await removeItemUsage(item.id, appId);
      setItem((prev) =>
        prev ? { ...prev, usages: prev.usages.filter((u) => u.id !== appId) } : null
      );
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر إزالة وسم الاستخدام.');
    } finally {
      setUsageLoading(false);
    }
  };

  const handleDeleteItem = async () => {
    if (!item) return;
    if (
      !window.confirm(
        `هل أنت متأكد من حذف الصنف (${item.name_ar})؟ لن يُسمح بالحذف إذا كان الصنف مستخدماً في حركات سابقة أو قوالب إنتاج أو معتمداً.`
      )
    ) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await deleteCatalogItem(item.id);
      onItemUpdated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر حذف الصنف.');
      setSaving(false);
    }
  };

  const assignedAppIds = new Set(item?.usages.map((u) => u.id) || []);
  const availableLines = allApplicationLines.filter((l) => !assignedAppIds.has(l.id));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  return (
    <div className="drawer-backdrop" onClick={onClose} aria-modal="true" role="dialog">
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()} dir="rtl">
        {/* Drawer Header */}
        <header className="drawer-header">
          <div className="drawer-header__title-wrap">
            <span className="drawer-header__eyebrow">بطاقة مواصفات وحوكمة الصنف</span>
            <h2 className="drawer-header__title">
              {loading ? 'جاري التحميل...' : item?.name_ar || 'تفاصيل الصنف'}
            </h2>
            {item && (
              <div className="drawer-header__badges">
                <code className="drawer-header__code">{item.code}</code>
                <ApprovalStatusBadge
                  status={item.approval_status}
                  hasPendingRevision={item.has_pending_revision}
                />
                <ClassificationBadge status={status} />
                <span
                  className={`catalog-pill ${
                    isActive ? 'catalog-pill--active' : 'catalog-pill--inactive'
                  }`}
                >
                  {isActive ? 'نشط تشغيلياً' : 'معطل'}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="إغلاق البطاقة"
          >
            ✕
          </button>
        </header>

        {/* Drawer Sub-Header Tabs */}
        <div className="drawer-tabs">
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'details' ? 'drawer-tab--active' : ''}`}
            onClick={() => setActiveTab('details')}
          >
            📋 تفاصيل الصنف والمواصفات
          </button>
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'revisions' ? 'drawer-tab--active' : ''}`}
            onClick={() => setActiveTab('revisions')}
          >
            🔄 طلبات التعديل {item?.has_pending_revision ? '• (مفتوح)' : ''}
          </button>
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'history' ? 'drawer-tab--active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            📜 سجل التدقيق التاريخي
          </button>
        </div>

        {/* Drawer Body */}
        <div className="drawer-body">
          {error && (
            <div className="catalog-alert catalog-alert--error" role="alert">
              <span className="catalog-alert__icon" aria-hidden>⚠️</span>
              <div className="catalog-alert__text">{error}</div>
            </div>
          )}

          {successMsg && (
            <div className="catalog-alert catalog-alert--success" role="status">
              <span className="catalog-alert__icon" aria-hidden>✓</span>
              <div className="catalog-alert__text">{successMsg}</div>
            </div>
          )}

          {/* Governance Lifecycle Banners */}
          {isDraft && (
            <div className="catalog-alert catalog-alert--info" role="note">
              <span className="catalog-alert__icon" aria-hidden>📝</span>
              <div className="catalog-alert__text">
                <strong>صنف مسودة (Draft):</strong> هذا الصنف قيد التجهيز ولا يمكن إدراجه في أوامر التشغيل أو الشراء حتى يتم اعتماده.
              </div>
              <button
                type="button"
                onClick={handleSubmitForReview}
                disabled={actionLoading}
                className="btn-teal btn-sm"
              >
                {actionLoading ? 'جاري التقديم...' : '🚀 تقديم الصنف للاعتماد'}
              </button>
            </div>
          )}

          {isPendingReview && (
            <div className="catalog-alert catalog-alert--warning catalog-alert--pulse" role="alert">
              <span className="catalog-alert__icon" aria-hidden>⏳</span>
              <div className="catalog-alert__text">
                <strong>قيد المراجعة والاعتماد:</strong> الصنف مقفل بانتظار قرار الإدارة أو المراجع المعتمد.
                {item?.submitted_by && ` (مقدم من: ${item.submitted_by})`}
              </div>
              <div className="drawer-alert__actions">
                <button
                  type="button"
                  onClick={handleApprove}
                  disabled={actionLoading}
                  className="btn-teal btn-sm"
                >
                  {actionLoading ? 'جاري الاعتماد...' : '✅ اعتماد الصنف'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRejectModal(true)}
                  disabled={actionLoading}
                  className="btn-danger btn-sm"
                >
                  ❌ رفض الاعتماد
                </button>
              </div>
            </div>
          )}

          {isRejected && (
            <div className="catalog-alert catalog-alert--error" role="alert">
              <span className="catalog-alert__icon" aria-hidden>⛔</span>
              <div className="catalog-alert__text">
                <strong>تم رفض اعتماد هذا الصنف:</strong> {item?.rejection_reason || 'يرجى مراجعة بيانات الصنف.'}
              </div>
              <button
                type="button"
                onClick={handleReopen}
                disabled={actionLoading}
                className="btn-secondary btn-sm"
              >
                {actionLoading ? 'جاري المعالجة...' : '🔄 إعادة فتح كمسودة للتعديل'}
              </button>
            </div>
          )}

          {/* Legacy Grandfathering Informational Notice */}
          {isGrandfatheredLegacy && (
            <div
              className="catalog-alert catalog-alert--warning"
              role="note"
              style={{
                background: '#fffbeb',
                borderColor: '#f59e0b',
                color: '#92400e',
                marginBottom: '1rem',
              }}
            >
              <span className="catalog-alert__icon" aria-hidden>
                ⚠️
              </span>
              <div className="catalog-alert__text">
                <strong>اعتماد تشغيلي انتقالي (Legacy Grandfathering):</strong>{' '}
                تم اعتماد هذا الصنف تشغيلياً لضمان استمرارية أرصدة المخزون وحركات الإنتاج التاريخية
                فقط. لم تعتمد إدارة المصنع مواصفاته الفنية أو تصنيفه النهائي بعد، واعتماد
                المواصفات مسجل كقرار مفتوح قيد الدراسة.
              </div>
            </div>
          )}

          {isApproved && (
            <div className="catalog-alert catalog-alert--approved" role="note">
              <span className="catalog-alert__icon" aria-hidden>🛡️</span>
              <div className="catalog-alert__text">
                <strong>صنف معتمد ومحمي (Approved):</strong> متاح للتشغيل. البيانات الأساسية مقفلة للحفاظ على سلامة أوامر الإنتاج وحركات المخزن التاريخية.
              </div>
              <div className="drawer-alert__actions">
                <button
                  type="button"
                  onClick={() => setShowRevisionModal(true)}
                  disabled={actionLoading || item?.has_pending_revision}
                  className="btn-secondary btn-sm"
                  title={item?.has_pending_revision ? 'يوجد طلب تعديل مفتوح بالفعل' : 'تقديم طلب تعديل'}
                >
                  📝 طلب تعديل الصنف
                </button>
                <button
                  type="button"
                  onClick={handleToggleActive}
                  disabled={actionLoading}
                  className="btn-link btn-sm"
                >
                  {isActive ? 'تعطيل الصنف' : 'إعادة التفعيل'}
                </button>
              </div>
            </div>
          )}

          {/* Pending Revision Card on Details Tab */}
          {item?.pending_revision && activeTab === 'details' && (
            <div className="catalog-revision-card">
              <div className="catalog-revision-card__header">
                <span className="catalog-revision-card__badge">طلب تعديل مفتوح #{item.pending_revision.revision_number}</span>
                <span className="catalog-revision-card__date">
                  مقدم من: {item.pending_revision.submitted_by}
                </span>
              </div>
              <p className="catalog-revision-card__summary">
                <strong>ملخص التعديل:</strong> {item.pending_revision.change_summary}
              </p>
              <div className="catalog-revision-card__actions">
                <button
                  type="button"
                  onClick={() => setActiveTab('revisions')}
                  className="btn-secondary btn-sm"
                >
                  عرض الفروقات والبت في التعديل ←
                </button>
              </div>
            </div>
          )}

          {/* Reject Dialog Prompt */}
          {showRejectModal && (
            <div className="catalog-modal-inline">
              <h4>تسجيل سبب رفض اعتماد الصنف</h4>
              <p>يرجى كتابة سبب الرفض بوضوح (10 أحرف على الأقل) لتوضيح النواقص لمسؤول الإدخال بالمصنع:</p>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="مثال: يرجى استكمال أبعاد العرض والوزن وتأكيد التصنيف..."
                className="drawer-textarea"
                rows={3}
              />
              <div className="catalog-modal-inline__actions">
                <button
                  type="button"
                  onClick={handleReject}
                  disabled={actionLoading || rejectReason.trim().length < 10}
                  className="btn-danger btn-sm"
                >
                  تأكيد الرفض
                </button>
                <button
                  type="button"
                  onClick={() => setShowRejectModal(false)}
                  className="btn-secondary btn-sm"
                >
                  إلغاء
                </button>
              </div>
            </div>
          )}

          {/* Revision Dialog Form */}
          {showRevisionModal && (
            <div className="catalog-modal-inline">
              <h4>تقديم طلب تعديل (Revision) للصنف المعتمد</h4>
              <p className="drawer-field__help">
                التعديلات المقترحة ستخضع للمراجعة والاعتماد؛ ويبقى الصنف الحالي معتمداً ونشطاً بالقيم الحالية حتى الموافقة.
              </p>
              <form onSubmit={handleCreateRevision}>
                <div className="drawer-row">
                  <label className="drawer-field">
                    <span className="drawer-field__label">الاسم المقترح بالعربية</span>
                    <input
                      type="text"
                      value={revProposedNameAr}
                      onChange={(e) => setRevProposedNameAr(e.target.value)}
                      className="drawer-input"
                      required
                    />
                  </label>
                  <label className="drawer-field">
                    <span className="drawer-field__label">التصنيف المقترح</span>
                    <select
                      value={revProposedCategoryId}
                      onChange={(e) => setRevProposedCategoryId(e.target.value)}
                      className="drawer-select"
                    >
                      <option value="">— بدون تصنيف —</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.parent_id ? `↳ ${c.name_ar}` : `■ ${c.name_ar}`} ({c.code})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="drawer-row">
                  <label className="drawer-field">
                    <span className="drawer-field__label">حالة التصنيف المقترحة</span>
                    <select
                      value={revProposedStatus}
                      onChange={(e) => setRevProposedStatus(e.target.value as ClassificationStatus)}
                      className="drawer-select"
                    >
                      <option value="confirmed">معتمد وموثق (Confirmed)</option>
                      <option value="suggested">مقترح (Suggested)</option>
                      <option value="needs_review">قيد المراجعة (Needs Review)</option>
                      <option value="not_applicable">غير خاضع (N/A)</option>
                    </select>
                  </label>
                  <label className="drawer-field">
                    <span className="drawer-field__label">سبب التعديل وملخصه *</span>
                    <input
                      type="text"
                      value={revisionSummary}
                      onChange={(e) => setRevisionSummary(e.target.value)}
                      placeholder="مثال: تصحيح تصنيف الخامة بعد فحص العينة..."
                      className="drawer-input"
                      required
                    />
                  </label>
                </div>
                <div className="drawer-grid-4">
                  <label className="drawer-field">
                    <span className="drawer-field__label">العرض (سم)</span>
                    <input
                      type="number"
                      step="any"
                      value={revProposedWidth}
                      onChange={(e) => setRevProposedWidth(e.target.value)}
                      className="drawer-input"
                    />
                  </label>
                  <label className="drawer-field">
                    <span className="drawer-field__label">الوزن (جرام/م²)</span>
                    <input
                      type="number"
                      step="any"
                      value={revProposedWeight}
                      onChange={(e) => setRevProposedWeight(e.target.value)}
                      className="drawer-input"
                    />
                  </label>
                  <label className="drawer-field">
                    <span className="drawer-field__label">الطول (سم)</span>
                    <input
                      type="number"
                      step="any"
                      value={revProposedLength}
                      onChange={(e) => setRevProposedLength(e.target.value)}
                      className="drawer-input"
                    />
                  </label>
                  <label className="drawer-field">
                    <span className="drawer-field__label">القطر (مم)</span>
                    <input
                      type="number"
                      step="any"
                      value={revProposedDiameter}
                      onChange={(e) => setRevProposedDiameter(e.target.value)}
                      className="drawer-input"
                    />
                  </label>
                </div>
                <div className="catalog-modal-inline__actions">
                  <button
                    type="submit"
                    disabled={actionLoading || revisionSummary.trim().length < 5}
                    className="btn-teal btn-sm"
                  >
                    تقديم طلب التعديل
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRevisionModal(false)}
                    className="btn-secondary btn-sm"
                  >
                    إلغاء
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* TAB 1: DETAILS & SPECS */}
          {activeTab === 'details' && (
            loading ? (
              <div className="drawer-loading" role="status">
                <span className="drawer-loading__spinner" aria-hidden />
                <span>جاري تحميل بيانات الصنف من الدليل...</span>
              </div>
            ) : item ? (
              <form onSubmit={handleSave} className="drawer-form">
                {/* القسم الأول: البيانات الأساسية */}
                <fieldset className="drawer-section" disabled={saving || isApproved || isPendingReview || isRejected}>
                  <legend className="drawer-section__legend">البيانات الأساسية</legend>

                  <div className="drawer-row">
                    <label className="drawer-field">
                      <span className="drawer-field__label">كود الصنف (الرمز الفريد)</span>
                      <input
                        type="text"
                        value={item.code}
                        readOnly
                        className="drawer-input drawer-input--readonly"
                      />
                    </label>

                    <label className="drawer-field">
                      <span className="drawer-field__label">اسم الصنف بالعربية *</span>
                      <input
                        type="text"
                        required
                        value={nameAr}
                        onChange={(e) => setNameAr(e.target.value)}
                        disabled={isFinishedGood || isApproved || isPendingReview}
                        className="drawer-input"
                      />
                    </label>
                  </div>

                  <div className="drawer-row">
                    <label className="drawer-field">
                      <span className="drawer-field__label">نوع الصنف التشغيلي *</span>
                      <select
                        value={itemType}
                        onChange={(e) => setItemType(e.target.value)}
                        disabled={isFinishedGood || isApproved || isPendingReview}
                        className="drawer-select"
                      >
                        {ITEM_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="drawer-field">
                      <span className="drawer-field__label">الوحدة الأساسية *</span>
                      <select
                        value={unitId}
                        onChange={(e) => setUnitId(e.target.value)}
                        disabled={isFinishedGood || isApproved || isPendingReview}
                        className="drawer-select"
                      >
                        {units.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name_ar} ({u.code})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="drawer-row">
                    <label className="drawer-field">
                      <span className="drawer-field__label">التصنيف الهرمي (Category)</span>
                      <select
                        value={categoryId}
                        onChange={(e) => setCategoryId(e.target.value)}
                        disabled={isFinishedGood || isApproved || isPendingReview}
                        className="drawer-select"
                      >
                        <option value="">— بدون تصنيف محدد —</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.parent_id ? `↳ ${c.name_ar}` : `■ ${c.name_ar}`} ({c.code})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="drawer-row drawer-row--checks">
                    <label className="drawer-checkbox">
                      <input
                        type="checkbox"
                        checked={isConsumable}
                        onChange={(e) => setIsConsumable(e.target.checked)}
                        disabled={isFinishedGood || isApproved || isPendingReview}
                      />
                      <span>صنف مستهلك بالتشغيل (Consumable)</span>
                    </label>

                    <label className="drawer-checkbox">
                      <input
                        type="checkbox"
                        checked={isActive}
                        onChange={(e) => setIsActive(e.target.checked)}
                        disabled={isApproved}
                      />
                      <span>صنف نشط ومتاح في العمليات (Active)</span>
                    </label>
                  </div>
                </fieldset>

                {/* القسم الثاني: حالة التصنيف وحد إعادة الطلب */}
                <fieldset className="drawer-section" disabled={saving || isApproved || isPendingReview || isRejected}>
                  <legend className="drawer-section__legend">حالة التصنيف وحد الطلب</legend>

                  <div className="drawer-row">
                    <label className="drawer-field">
                      <span className="drawer-field__label">حالة اعتماد التصنيف</span>
                      <select
                        value={status}
                        onChange={(e) => setStatus(e.target.value as ClassificationStatus)}
                        disabled={isFinishedGood || isApproved || isPendingReview}
                        className="drawer-select"
                      >
                        <option value="needs_review">قيد المراجعة (Needs Review)</option>
                        <option value="suggested">مقترح بالدليل (Suggested)</option>
                        <option value="confirmed">معتمد وموثق (Confirmed)</option>
                        <option value="not_applicable">غير خاضع للتصنيف (N/A)</option>
                      </select>
                    </label>

                    <label className="drawer-field">
                      <span className="drawer-field__label">حد إعادة الطلب (Reorder Level)</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={reorderLevel}
                        onChange={(e) => setReorderLevel(parseFloat(e.target.value) || 0)}
                        className="drawer-input"
                      />
                      <span className="drawer-field__help">
                        القيمة 0 تعني عدم تفعيل تنبيهات انخفاض الرصيد لهذا الصنف.
                      </span>
                    </label>
                  </div>
                </fieldset>

                {/* القسم الثالث: المواصفات الفنية والأبعاد */}
                <fieldset className="drawer-section" disabled={saving || isApproved || isPendingReview || isRejected}>
                  <legend className="drawer-section__legend">المواصفات الفنية والأبعاد القياسية</legend>
                  <p className="drawer-section__desc">
                    تُسجل كخصائص JSONB عامة؛ املأ الحقول المناسبة لطبيعة الصنف (قماش، إكسسوار، خيط، تغليف).
                  </p>

                  <div className="drawer-grid-4">
                    <label className="drawer-field">
                      <span className="drawer-field__label">عرض الصنف (سم)</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="مثال: 150"
                        value={widthCm}
                        onChange={(e) => setWidthCm(e.target.value)}
                        className="drawer-input"
                      />
                    </label>

                    <label className="drawer-field">
                      <span className="drawer-field__label">وزن المتر المربع (جرام/م²)</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="مثال: 180"
                        value={weightGsm}
                        onChange={(e) => setWeightGsm(e.target.value)}
                        className="drawer-input"
                      />
                    </label>

                    <label className="drawer-field">
                      <span className="drawer-field__label">الطول (سم)</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="مثال: 50"
                        value={lengthCm}
                        onChange={(e) => setLengthCm(e.target.value)}
                        className="drawer-input"
                      />
                    </label>

                    <label className="drawer-field">
                      <span className="drawer-field__label">القطر (مم)</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="مثال: 14"
                        value={diameterMm}
                        onChange={(e) => setDiameterMm(e.target.value)}
                        className="drawer-input"
                      />
                    </label>
                  </div>
                </fieldset>

                {/* القسم الرابع: خطوط وتطبيقات الملابس المرتبطة */}
                <div className="drawer-section">
                  <div className="drawer-section__header-row">
                    <div>
                      <h3 className="drawer-section__legend">خطوط الاستخدام وتطبيقات الملابس</h3>
                      <p className="drawer-section__desc">
                        وسوم تنظيمية تساعد مسؤولي المخزن والإنتاج على معرفة موديلات الملابس المناسبة لهذا الصنف.
                      </p>
                    </div>
                  </div>

                  <div className="drawer-usages">
                    {item.usages.length === 0 ? (
                      <div className="drawer-usages__empty">
                        لم يتم ربط الصنف بأي خط استخدام محدد بعد (افتراضي: عام لجميع الخطوط).
                      </div>
                    ) : (
                      <div className="drawer-usages__tags">
                        {item.usages.map((u) => (
                          <span key={u.id} className="drawer-tag">
                            <span>{u.name_ar}</span>
                            <code className="drawer-tag__code">{u.code}</code>
                            <button
                              type="button"
                              className="drawer-tag__remove"
                              onClick={() => void handleRemoveUsage(u.id)}
                              disabled={usageLoading}
                              title="إزالة وسم الاستخدام"
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    {availableLines.length > 0 && (
                      <div className="drawer-usages__add-row">
                        <select
                          value={selectedAppToAdd}
                          onChange={(e) => setSelectedAppToAdd(e.target.value)}
                          className="drawer-select drawer-usages__select"
                          disabled={usageLoading}
                        >
                          <option value="">— اختر خط استخدام لربطه بالصنف —</option>
                          {availableLines.map((line) => (
                            <option key={line.id} value={line.id}>
                              {line.name_ar} ({line.code})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => void handleAddUsage()}
                          disabled={!selectedAppToAdd || usageLoading}
                          className="btn-secondary"
                        >
                          {usageLoading ? 'جاري الإضافة...' : '＋ ربط الخط'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* أزرار الإجراءات السفلية */}
                <div className="drawer-actions">
                  {!isApproved && !isPendingReview && (
                    <button
                      type="submit"
                      disabled={saving}
                      className="btn-teal drawer-actions__save"
                    >
                      {saving ? 'جاري الحفظ...' : 'حفظ التعديلات'}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={onClose}
                    disabled={saving}
                    className="btn-secondary"
                  >
                    إغلاق
                  </button>

                  {!isFinishedGood && isDraft && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteItem()}
                      disabled={saving}
                      className="btn-danger drawer-actions__delete"
                    >
                      حذف الصنف
                    </button>
                  )}
                </div>
              </form>
            ) : null
          )}

          {/* TAB 2: REVISIONS */}
          {activeTab === 'revisions' && (
            <div className="drawer-revisions-tab">
              {/* Revision Reject Prompt Inline */}
              {revisionRejectId && (
                <div className="catalog-modal-inline">
                  <h4>سبب رفض طلب التعديل</h4>
                  <textarea
                    value={revisionRejectReason}
                    onChange={(e) => setRevisionRejectReason(e.target.value)}
                    placeholder="اكتب سبب رفض طلب التعديل (إلزامي لا يقل عن 10 أحرف)..."
                    className="drawer-textarea"
                    rows={2}
                  />
                  <div className="catalog-modal-inline__actions">
                    <button
                      type="button"
                      onClick={handleRejectRevision}
                      disabled={actionLoading || revisionRejectReason.trim().length < 10}
                      className="btn-danger btn-sm"
                    >
                      تأكيد الرفض
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRevisionRejectId(null);
                        setRevisionRejectReason('');
                      }}
                      className="btn-secondary btn-sm"
                    >
                      إلغاء
                    </button>
                  </div>
                </div>
              )}

              {revisionsLoading ? (
                <div className="drawer-loading" role="status">
                  <span className="drawer-loading__spinner" aria-hidden />
                  <span>جاري تحميل طلبات التعديل...</span>
                </div>
              ) : revisions.length === 0 ? (
                <div className="catalog-table__state catalog-table__state--empty">
                  <p>لا توجد طلبات تعديل مسجلة لهذا الصنف حتى الآن.</p>
                  {isApproved && (
                    <button
                      type="button"
                      onClick={() => setShowRevisionModal(true)}
                      className="btn-teal btn-sm"
                    >
                      ＋ تقديم أول طلب تعديل
                    </button>
                  )}
                </div>
              ) : (
                <div className="catalog-revisions-list">
                  {revisions.map((rev) => {
                    const isPending = rev.status === 'pending_review';
                    const changes = rev.proposed_changes || {};
                    return (
                      <article
                        key={rev.id}
                        className={`catalog-rev-item catalog-rev-item--${rev.status}`}
                      >
                        <div className="catalog-rev-item__header">
                          <div>
                            <span className="catalog-rev-item__num">طلب تعديل #{rev.revision_number}</span>
                            <span className={`approval-badge approval-badge--${rev.status === 'applied' ? 'approved' : rev.status === 'pending_review' ? 'pending' : 'rejected'}`}>
                              {rev.status === 'applied' ? 'معتمد ومطبق' : rev.status === 'pending_review' ? 'قيد المراجعة' : rev.status === 'cancelled' ? 'ملغي' : 'مرفوض'}
                            </span>
                          </div>
                          <span className="catalog-rev-item__meta">
                            {new Date(rev.submitted_at).toLocaleDateString('ar-EG')} · قدمه: {rev.submitted_by}
                          </span>
                        </div>

                        <div className="catalog-rev-item__summary">
                          <strong>الملخص:</strong> {rev.change_summary}
                        </div>

                        {/* Diff Box */}
                        <div className="catalog-rev-diff">
                          <div className="catalog-rev-diff__title">الفروقات والتغييرات المقترحة:</div>
                          <table className="catalog-diff-table">
                            <thead>
                              <tr>
                                <th>الحقل</th>
                                <th>القيمة الحالية (المعتمدة)</th>
                                <th>القيمة المقترحة بالطلب</th>
                              </tr>
                            </thead>
                            <tbody>
                              {changes.name_ar !== undefined && (
                                <tr>
                                  <td>اسم الصنف</td>
                                  <td>{item?.name_ar}</td>
                                  <td className="catalog-diff-table__new">{String(changes.name_ar)}</td>
                                </tr>
                              )}
                              {changes.category_id !== undefined && (
                                <tr>
                                  <td>التصنيف</td>
                                  <td>{item?.category_id ? categoryMap.get(item.category_id)?.name_ar : '—'}</td>
                                  <td className="catalog-diff-table__new">
                                    {changes.category_id ? categoryMap.get(String(changes.category_id))?.name_ar || String(changes.category_id) : 'بدون تصنيف'}
                                  </td>
                                </tr>
                              )}
                              {changes.classification_status !== undefined && (
                                <tr>
                                  <td>حالة التصنيف</td>
                                  <td>{item?.classification_status}</td>
                                  <td className="catalog-diff-table__new">{String(changes.classification_status)}</td>
                                </tr>
                              )}
                              {changes.attributes !== undefined && (
                                <tr>
                                  <td>المواصفات الفنية</td>
                                  <td><code>{JSON.stringify(item?.attributes || {})}</code></td>
                                  <td className="catalog-diff-table__new">
                                    <code>{JSON.stringify(changes.attributes)}</code>
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>

                        {rev.rejection_reason && (
                          <div className="catalog-rev-item__reject-note">
                            <strong>سبب الرفض:</strong> {rev.rejection_reason}
                          </div>
                        )}

                        {isPending && (
                          <div className="catalog-rev-item__actions">
                            <button
                              type="button"
                              onClick={() => handleApproveRevision(rev.id)}
                              disabled={actionLoading}
                              className="btn-teal btn-sm"
                            >
                              ✅ اعتماد وتطبيق التعديل
                            </button>
                            <button
                              type="button"
                              onClick={() => setRevisionRejectId(rev.id)}
                              disabled={actionLoading}
                              className="btn-danger btn-sm"
                            >
                              ❌ رفض التعديل
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCancelRevision(rev.id)}
                              disabled={actionLoading}
                              className="btn-secondary btn-sm"
                            >
                              إلغاء الطلب
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: AUDIT HISTORY TIMELINE */}
          {activeTab === 'history' && (
            <div className="drawer-history-tab">
              {historyLoading ? (
                <div className="drawer-loading" role="status">
                  <span className="drawer-loading__spinner" aria-hidden />
                  <span>جاري استدعاء سجل التدقيق التاريخي...</span>
                </div>
              ) : history.length === 0 ? (
                <p>لا توجد حركات تدقيق مسجلة لهذا الصنف.</p>
              ) : (
                <div className="catalog-timeline" aria-label="الخط الزمني لسجل التدقيق">
                  {history.map((event) => (
                    <div key={event.id} className="catalog-timeline__item">
                      <div className="catalog-timeline__badge">
                        {event.event_type === 'approved' ? '✅' : event.event_type === 'rejected' ? '❌' : event.event_type === 'submitted' ? '🚀' : event.event_type === 'created' ? '🌱' : event.event_type.startsWith('revision') ? '🔄' : '📌'}
                      </div>
                      <div className="catalog-timeline__content">
                        <div className="catalog-timeline__header">
                          <strong className="catalog-timeline__type">
                            {event.event_type === 'legacy_backfill' ? 'اعتماد تاريخي استمراري (Phase 3.5 Backfill)' : event.event_type === 'created' ? 'إنشاء مسودة الصنف' : event.event_type === 'submitted' ? 'تقديم للمراجعة والاعتماد' : event.event_type === 'approved' ? 'اعتماد الصنف رسمياً' : event.event_type === 'rejected' ? 'رفض اعتماد الصنف' : event.event_type === 'reopened' ? 'إعادة فتح كمسودة' : event.event_type === 'deactivated' ? 'تعطيل الصنف' : event.event_type === 'reactivated' ? 'إعادة تفعيل الصنف' : event.event_type === 'revision_submitted' ? 'تقديم طلب تعديل' : event.event_type === 'revision_applied' ? 'اعتماد وتطبيق طلب تعديل' : event.event_type === 'revision_rejected' ? 'رفض طلب تعديل' : event.event_type}
                          </strong>
                          <span className="catalog-timeline__date">
                            {new Date(event.created_at).toLocaleString('ar-EG')}
                          </span>
                        </div>
                        <div className="catalog-timeline__meta">
                          <span>المستخدم: <code>{event.actor_id}</code></span>
                          <span>الدور: <code>{event.actor_role}</code></span>
                          {event.from_status && (
                            <span>
                              الحالة: {event.from_status} ← {event.to_status}
                            </span>
                          )}
                        </div>
                        {event.reason && (
                          <div className="catalog-timeline__reason">
                            <strong>البيان / السبب:</strong> {event.reason}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
