/**
 * OrderDetailModal (T4.2 Backward-Compatibility Adapter)
 * ─────────────────────────────────────────────────────────────────────────────
 * تم تفكيك الـ Modal المتضخم (2,248 سطراً) إلى صفحة تفاصيل مستقلة (OrderDetailsPage)
 * مع أقسام معيارية في مجلد orderDetails/.
 * يعمل هذا المكون الآن كمحول رقيق (Thin Adapter) يضمن استمرار عمل أي اختبارات أو مسارات
 * تعتمد على واجهة OrderDetailModal السابقة دون ازدواجية في منطق العمليات.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React from 'react';
import { OrderDetailsPage } from './OrderDetailsPage';
import type { ProductionOrder, CatalogItem } from './productionApi';
import type { OrderDetailTab } from '@/lib/navigation';

export interface OrderDetailModalProps {
  order: ProductionOrder;
  isOpen?: boolean;
  onClose: () => void;
  onOrderUpdated: (updatedOrder: ProductionOrder) => void;
  catalogItems?: CatalogItem[];
  isCatalogLoading?: boolean;
  catalogError?: string | null;
  /** فتح الأمر مباشرة على قسم محدد (من صندوق المهام) */
  initialTab?: OrderDetailTab;
}

export const OrderDetailModal: React.FC<OrderDetailModalProps> = ({
  order,
  isOpen = true,
  onClose,
  onOrderUpdated,
  catalogItems,
  isCatalogLoading,
  catalogError,
  initialTab,
}) => {
  if (!isOpen) return null;
  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal-card modal-card--xl"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
        style={{ maxHeight: '92vh', overflowY: 'auto' }}
      >
        <OrderDetailsPage
          order={order}
          onBack={onClose}
          onOrderUpdated={onOrderUpdated}
          catalogItems={catalogItems}
          isCatalogLoading={isCatalogLoading}
          catalogError={catalogError}
          initialTab={initialTab}
          isModalWrapper
        />
      </div>
    </div>
  );
};
