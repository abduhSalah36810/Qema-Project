import { SupplierPurchasingView } from './SupplierPurchasingView';

export function SuppliersView() {
  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="suppliers-page-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة المشتريات والتوريد</span>
          <h2 id="suppliers-page-title">الموردون وفواتير الخامات</h2>
          <p>
            تسجيل بيانات الموردين، إصدار فواتير الخامات، تأكيد استلام الشحنات بمخزن الخامات، وسداد المستحقات.
          </p>
        </div>
      </header>

      {/* شاشة الموردين وفواتير الشراء المعتمدة */}
      <SupplierPurchasingView />
    </section>
  );
}

