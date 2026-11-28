// HelpDialog: the family's one help panel (owner, 2026-11-13). A movable, resizable, pop-out-able FloatingDialog
// with the lab's help sections and an optional link-out to the full docs in the footer. Shared service: vendor it,
// never edit a lab's copy.
import FloatingDialog from "../floating-dialog/FloatingDialog";

export default function HelpDialog({ isOpen, onClose, sections = [], docsUrl = null, title = "Help", storageKey = "help-dialog" }) {
  return (
    <FloatingDialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      ariaLabel="Help"
      defaultWidth={480}
      defaultHeight={null}
      placement="right"
      storageKey={storageKey}
      singletonKey="help-dialog"
      footer={
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <span>{docsUrl ? <a href={docsUrl}>{docsUrl}</a> : null}</span>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      }
      testId="help-dialog"
    >
      {sections.length === 0 ? (
        <p className="note">No help topics yet.</p>
      ) : (
        sections.map((s) => (
          <section key={s.heading}>
            <h2>{s.heading}</h2>
            {Array.isArray(s.body) ? s.body.map((p, i) => <p key={i}>{p}</p>) : <p>{s.body}</p>}
          </section>
        ))
      )}
    </FloatingDialog>
  );
}
