import { useState, useEffect } from 'react';
import {
  financeApi,
  errorMessage,
  formatMoney,
  type CashAccount,
} from '../financeApi';
import {
  KpiCard,
  KpiGrid,
  Panel,
} from './reportUi';
import {
  CustomerStatementSection,
  SupplierStatementSection,
  CustodySection,
  PayrollSection,
} from '../FinancialReportsView';

export type AccountStatementType = 'customer' | 'supplier' | 'employee' | 'treasury' | 'custody' | 'gl';

export function AccountStatementsView({ initialType = 'customer' }: { initialType?: AccountStatementType }) {
  const [statementType, setStatementType] = useState<AccountStatementType>(initialType);
  const [customerId, setCustomerId] = useState('');
  const [supplierId, setSupplierId] = useState('');

  // Treasury statement state
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [statement, setStatement] = useState<any>(null);
  const [treasuryLoading, setTreasuryLoading] = useState(false);
  const [treasuryError, setTreasuryError] = useState('');

  useEffect(() => {
    let alive = true;
    financeApi
      .getAccounts()
      .then((res) => {
        if (!alive) return;
        setAccounts(res);
        if (res.length > 0 && !selectedAccountId) {
          const treasuryAcc = res.find((a) => a.account_type === 'treasury') || res[0];
          setSelectedAccountId(treasuryAcc.id);
        }
      })
      .catch((err: unknown) => {
        if (alive) setTreasuryError(errorMessage(err, 'تعذر تحميل الحسابات النقدية.'));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (statementType !== 'treasury' || !selectedAccountId) return;
    let alive = true;
    setTreasuryLoading(true);
    setTreasuryError('');
    financeApi
      .getCashAccountStatement(selectedAccountId)
      .then((res) => {
        if (alive) setStatement(res);
      })
      .catch((err: unknown) => {
        if (alive) {
          setStatement(null);
          setTreasuryError(errorMessage(err, 'تعذر تحميل كشف حركة الخزينة.'));
        }
      })
      .finally(() => {
        if (alive) setTreasuryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [statementType, selectedAccountId]);

  const statementTitles: Record<AccountStatementType, string> = {
    customer: 'كشف حساب عميل',
    supplier: 'كشف حساب مورد',
    employee: 'كشف حساب موظف',
    treasury: 'كشف حساب خزينة',
    custody: 'كشف حساب عهدة',
    gl: 'كشف حساب الأستاذ العام',
  };

  return (
    <section className="warehouse-page rh" dir="rtl" aria-labelledby="account-statements-title">
      <header className="rh-head">
        <div>
          <span className="rh-eyebrow">التقارير المالية · مطابقة الحسابات والأرصدة</span>
          <h2 id="account-statements-title">كشوف الحسابات</h2>
          <p>كشوف الحسابات التفصيلية للعملاء، الموردين، الموظفين، الخزائن والعهد، ودفتر الأستاذ العام.</p>
        </div>
        <div className="rh-head__actions no-print">
          <button type="button" className="btn btn--secondary" onClick={() => window.print()}>
            طباعة / حفظ PDF
          </button>
        </div>
      </header>

      <div className="rh-subnav no-print" role="tablist" aria-label="أنواع كشوف الحسابات" style={{ marginBottom: '1.5rem' }}>
        <button
          type="button"
          role="tab"
          aria-selected={statementType === 'customer'}
          aria-pressed={statementType === 'customer'}
          onClick={() => setStatementType('customer')}
        >
          كشف حساب عميل
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={statementType === 'supplier'}
          aria-pressed={statementType === 'supplier'}
          onClick={() => setStatementType('supplier')}
        >
          كشف حساب مورد
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={statementType === 'employee'}
          aria-pressed={statementType === 'employee'}
          onClick={() => setStatementType('employee')}
        >
          كشف حساب موظف
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={statementType === 'treasury'}
          aria-pressed={statementType === 'treasury'}
          onClick={() => setStatementType('treasury')}
        >
          كشف حساب خزينة
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={statementType === 'custody'}
          aria-pressed={statementType === 'custody'}
          onClick={() => setStatementType('custody')}
        >
          كشف حساب عهدة
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={statementType === 'gl'}
          aria-pressed={statementType === 'gl'}
          onClick={() => setStatementType('gl')}
        >
          كشف حساب الأستاذ العام
        </button>
      </div>

      <h2 className="rh-print-title">مصنع القمة للملابس — {statementTitles[statementType]} (الأرصدة حتى اليوم)</h2>

      {statementType === 'customer' && (
        <CustomerStatementSection customerId={customerId} onChange={setCustomerId} />
      )}

      {statementType === 'supplier' && (
        <SupplierStatementSection supplierId={supplierId} onChange={setSupplierId} />
      )}

      {statementType === 'employee' && (
        <PayrollSection />
      )}

      {statementType === 'treasury' && (
        <>
          <div className="rh-toolbar" style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>اختر الحساب النقدي:</span>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                aria-label="اختر الحساب النقدي"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.account_number}) — {a.account_type === 'bank' ? 'بنك' : a.account_type === 'petty_cash' ? 'عهدة' : 'خزينة'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {treasuryLoading ? (
            <p>جارٍ تحميل كشف الحساب...</p>
          ) : treasuryError ? (
            <p className="rh-error">{treasuryError}</p>
          ) : statement?.statement ? (
            <>
              <KpiGrid>
                <KpiCard label="الرصيد الافتتاحي" value={formatMoney(statement.statement.opening_balance)} />
                <KpiCard label="إجمالي المقبوضات (مدين)" value={formatMoney(statement.statement.total_debit)} />
                <KpiCard label="إجمالي المدفوعات (دائن)" value={formatMoney(statement.statement.total_credit)} />
                <KpiCard label="الرصيد الختامي" value={formatMoney(statement.statement.closing_balance)} emphasis />
              </KpiGrid>

              <Panel title={`حركات الحساب: ${statement.account?.name || ''}`}>
                <div className="rh-table__wrap">
                  <table className="rh-table rh-table--wide">
                    <thead>
                      <tr>
                        <th>التاريخ</th>
                        <th>نوع الحركة</th>
                        <th>المرجع</th>
                        <th>البيان</th>
                        <th style={{ textAlign: 'left' }}>مدين</th>
                        <th style={{ textAlign: 'left' }}>دائن</th>
                        <th style={{ textAlign: 'left' }}>الرصيد المتتابع</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.statement.transactions.map((tx: any, idx: number) => (
                        <tr key={`${tx.reference}-${idx}`}>
                          <td>{tx.date?.slice(0, 10)}</td>
                          <td>{tx.type}</td>
                          <td><code>{tx.reference}</code></td>
                          <td>{tx.description}</td>
                          <td style={{ textAlign: 'left' }}>{formatMoney(tx.debit)}</td>
                          <td style={{ textAlign: 'left' }}>{formatMoney(tx.credit)}</td>
                          <td style={{ textAlign: 'left' }}><strong>{formatMoney(tx.running_balance)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          ) : (
            <p className="rh-state">لا توجد حركات مسجلة لهذا الحساب في الفترة المحددة.</p>
          )}
        </>
      )}

      {statementType === 'custody' && (
        <CustodySection />
      )}

      {statementType === 'gl' && (
        <Panel title="دفتر الأستاذ العام" subtitle="حركات القيود اليومية حسب الحساب والفترة">
          <p className="rh-period-note">
            يمكنك فحص دفتر الأستاذ العام وتفاصيل أي حساب بالنقر مباشرة على سطر الحساب في <strong>قائمة الدخل</strong> أو <strong>الميزانية العمومية</strong>.
          </p>
        </Panel>
      )}
    </section>
  );
}

