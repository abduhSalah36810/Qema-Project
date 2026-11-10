import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DialogProvider, useDialog } from './DialogProvider';

function Trigger({ onResult }: { onResult?: (res: boolean) => void }) {
  const dialog = useDialog();
  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          const ok = await dialog.confirm({
            title: 'تأكيد العملية',
            message: 'هل تريد المتابعة؟',
            confirmLabel: 'موافق',
            cancelLabel: 'تراجع',
          });
          onResult?.(ok);
        }}
      >
        فتح الحوار
      </button>
      <button type="button">زر خلفي</button>
    </div>
  );
}

describe('DialogProvider accessibility and focus trap', () => {
  it('traps Tab/Shift+Tab focus inside dialog and closes on Escape', async () => {
    let result: boolean | undefined;
    render(
      <DialogProvider>
        <Trigger onResult={(ok) => { result = ok; }} />
      </DialogProvider>
    );

    const openBtn = screen.getByRole('button', { name: 'فتح الحوار' });
    openBtn.focus();
    fireEvent.click(openBtn);

    const cancelBtn = await screen.findByRole('button', { name: 'تراجع' });
    const confirmBtn = screen.getByRole('button', { name: 'موافق' });
    expect(document.activeElement).toBe(confirmBtn);

    // Tab من آخر عنصر في الحوار يرجع إلى أول عنصر داخل الحوار (وليس الزر الخلفي)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(cancelBtn);

    // Shift+Tab من أول عنصر في الحوار يرجع إلى آخر عنصر داخل الحوار
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn);

    // Escape يغلق الحوار ويعيد النتيجة false
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(result).toBe(false));
  });
});

