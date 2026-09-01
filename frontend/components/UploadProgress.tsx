"use client";

/**
 * Upload and conversion progress (§52).
 *
 * Upload progress is real, reported by the Blob SDK. Conversion progress is
 * coarse and stage-driven — §52 forbids inventing a percentage, so when no
 * stage is known the bar is explicitly indeterminate rather than faked.
 */

interface UploadProgressProps {
  label: string;
  percentage?: number;
  detail?: string;
}

export function UploadProgress({
  label,
  percentage,
  detail,
}: UploadProgressProps) {
  const indeterminate = percentage === undefined;

  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={indeterminate ? undefined : percentage}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuetext={indeterminate ? "In progress" : `${percentage}%`}
      >
        <strong>{label}</strong>
        {!indeterminate && <span className="muted"> — {percentage}%</span>}
        <div className="progress-track">
          <div
            className="progress-fill"
            data-indeterminate={indeterminate}
            style={indeterminate ? undefined : { width: `${percentage}%` }}
          />
        </div>
      </div>
      {detail && <p className="muted">{detail}</p>}
    </div>
  );
}
