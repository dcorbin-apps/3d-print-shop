import { useEffect, useState } from 'react';
import { picturePath } from '@3d-print-shop/client/browser';
import type { Job } from '@3d-print-shop/client/browser';

interface JobPictureProps {
  job: Job;
}

// AIDEV-NOTE: an <img> at the shop's own URL rather than a Blob from `shop.picture`, so the browser's
// cache is what spares the next poll from asking again - the shop tells it to keep one for an hour.
// The larger one is the SAME picture: it is there to tell plates apart, not to inspect a print by.
export function JobPicture({ job }: JobPictureProps): React.JSX.Element | null {
  const [shown, setShown] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!shown) return;

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShown(false);
    };
    window.addEventListener('keydown', closeOnEscape);

    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [shown]);

  if (unavailable) return null;

  return (
    <>
      <button type="button" className="picture" aria-label={`Show ${job.displayName} larger`} onClick={() => setShown(true)}>
        <img src={picturePath(job.id)} alt="" onError={() => setUnavailable(true)} />
      </button>

      {shown && (
        <div className="picture-shown" role="dialog" aria-modal="true" aria-label={job.displayName} onClick={() => setShown(false)}>
          <img src={picturePath(job.id)} alt={job.displayName} />
        </div>
      )}
    </>
  );
}
