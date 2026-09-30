import type { ReactNode } from "react";
import type { ClientFailure } from "../client/result.ts";
import { describeFailure } from "../format/labels.ts";
import { formatInstant } from "../format/time.ts";
import type { Instant } from "../../domain/instants.ts";

export const LoadingState = ({ label }: { readonly label: string }) => (
  <div className="state" role="status" aria-live="polite">
    <span className="spinner" aria-hidden="true" />
    <p>{label}</p>
  </div>
);

export const EmptyState = ({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail: string;
}) => (
  <div className="state state--empty">
    <h3>{title}</h3>
    <p>{detail}</p>
  </div>
);

export const ErrorNotice = ({
  failure,
  onRetry,
}: {
  readonly failure: ClientFailure;
  readonly onRetry: (() => void) | null;
}) => (
  <div className="notice notice--danger" role="alert">
    <p>{describeFailure(failure)}</p>
    {onRetry === null ? null : (
      <button type="button" className="button button--neutral" onClick={onRetry}>
        Try again
      </button>
    )}
  </div>
);

export const StaleNotice = ({
  at,
  failure,
}: {
  readonly at: Instant | null;
  readonly failure: ClientFailure;
}) => (
  <div className="notice notice--warning" role="status">
    <p>
      Showing the last known settings{at === null ? "" : ` from ${formatInstant(at)}`}.{" "}
      {describeFailure(failure)}
    </p>
  </div>
);

export const MutationNotice = ({
  tone,
  message,
  onRetry,
  onDismiss,
}: {
  readonly tone: "success" | "warning" | "danger";
  readonly message: string;
  readonly onRetry: (() => void) | null;
  readonly onDismiss: () => void;
}) => (
  <div className={`notice notice--${tone}`} role="status">
    <p>{message}</p>
    <div className="notice__actions">
      {onRetry === null ? null : (
        <button type="button" className="button button--neutral" onClick={onRetry}>
          Retry the same request
        </button>
      )}
      <button type="button" className="button button--quiet" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  </div>
);

export const Card = ({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string | null;
  readonly children: ReactNode;
}) => (
  <section className="card">
    <header className="card__header">
      <h2>{title}</h2>
      {description === null ? null : <p className="card__description">{description}</p>}
    </header>
    {children}
  </section>
);

export const DefinitionRow = ({
  term,
  children,
}: {
  readonly term: string;
  readonly children: ReactNode;
}) => (
  <div className="definition">
    <dt>{term}</dt>
    <dd>{children}</dd>
  </div>
);
