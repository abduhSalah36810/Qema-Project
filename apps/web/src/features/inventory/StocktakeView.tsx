import React, { useState } from 'react';
import { StocktakeListView } from './StocktakeListView';
import { StocktakeDetailView } from './StocktakeDetailView';
import { CreateStocktakeModal } from './CreateStocktakeModal';
import { StocktakeSession } from './stocktakeApi';

export const StocktakeView: React.FC = () => {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);

  const handleSessionCreated = (newSession: StocktakeSession) => {
    setSelectedSessionId(newSession.id);
  };

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="stocktake-management-title">
      {!selectedSessionId ? (
        <>
          <header className="warehouse-page__header" style={{ marginBottom: '1.25rem' }}>
            <div>
              <span className="warehouse-page__eyebrow">إدارة المخازن والأرصدة الدفترية</span>
              <h2 id="stocktake-management-title" style={{ margin: '0.25rem 0' }}>
                الجرد والتسويات المخزنية
              </h2>
              <p style={{ margin: 0, color: '#64748b', fontSize: '0.9rem' }}>
                تثبيت اللقطات الدفترية، تسجيل العد الفعلي الميداني، ومراجعة واعتماد فروقات الجرد وترحيلها للأستاذ
              </p>
            </div>
          </header>

          <StocktakeListView
            onSelectSession={(id) => setSelectedSessionId(id)}
            onOpenCreateModal={() => setIsCreateModalOpen(true)}
          />
        </>
      ) : (
        <StocktakeDetailView
          sessionId={selectedSessionId}
          onBack={() => setSelectedSessionId(null)}
        />
      )}

      {/* نافذة فتح جلسة جرد جديدة */}
      <CreateStocktakeModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleSessionCreated}
      />
    </section>
  );
};

