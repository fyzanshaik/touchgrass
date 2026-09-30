import type { ReactNode } from "react";

export type ButtonTone = "primary" | "neutral" | "danger" | "quiet";

export const Button = ({
  label,
  onClick,
  type,
  tone,
  disabled,
  busy,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly type: "button" | "submit";
  readonly tone: ButtonTone;
  readonly disabled: boolean;
  readonly busy: boolean;
}) => (
  <button
    type={type}
    className={`button button--${tone}`}
    onClick={onClick}
    disabled={disabled || busy}
    aria-busy={busy ? "true" : undefined}
  >
    {label}
  </button>
);

export const TextField = ({
  id,
  label,
  hint,
  value,
  onInput,
  type,
  inputMode,
  placeholder,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string | null;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly type: "text" | "url" | "number" | "search";
  readonly inputMode: "text" | "numeric" | "search" | null;
  readonly placeholder: string | null;
  readonly disabled: boolean;
}) => (
  <div className="field">
    <label htmlFor={id}>{label}</label>
    {hint === null ? null : (
      <p className="field__hint" id={`${id}-hint`}>
        {hint}
      </p>
    )}
    <input
      id={id}
      type={type}
      inputMode={inputMode ?? undefined}
      placeholder={placeholder ?? undefined}
      value={value}
      disabled={disabled}
      aria-describedby={hint === null ? undefined : `${id}-hint`}
      onChange={(event) => onInput(event.currentTarget.value)}
    />
  </div>
);

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export const SelectField = ({
  id,
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string | null;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) => (
  <div className="field">
    <label htmlFor={id}>{label}</label>
    {hint === null ? null : (
      <p className="field__hint" id={`${id}-hint`}>
        {hint}
      </p>
    )}
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-describedby={hint === null ? undefined : `${id}-hint`}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </div>
);

export const SwitchField = ({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled: boolean;
}) => (
  <div className="field field--switch">
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
    <div className="field__body">
      <label htmlFor={id}>{label}</label>
      {description === null ? null : <p className="field__hint">{description}</p>}
    </div>
  </div>
);

export const CheckboxField = ({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled: boolean;
}) => (
  <div className="field field--check">
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-describedby={`${id}-hint`}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
    <div className="field__body">
      <label htmlFor={id}>{label}</label>
      <p className="field__hint" id={`${id}-hint`}>
        {description}
      </p>
    </div>
  </div>
);

export const SubHeading = ({ children }: { readonly children: ReactNode }) => (
  <h3 className="subheading">{children}</h3>
);
