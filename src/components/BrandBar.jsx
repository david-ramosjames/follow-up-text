import { Star } from "lucide-react";
import { useState } from "react";

// The firm's logo is dropped in at public/logo.svg (or .png) rather than being
// redrawn here — tracing a wordmark by hand gets it subtly wrong, and this is
// the firm's own identity. Until that file exists the lockup below stands in:
// the five stars and the wordmark, which are the parts that can be set
// faithfully in type. The shield monogram is not faked.
export default function BrandBar({ strap = "Client follow-ups" }) {
  const [logoFailed, setLogoFailed] = useState(false);

  return (
    <div className="brand-bar">
      <div className="brand-mark">
        {logoFailed ? (
          <span className="brand-fallback">
            <span className="brand-stars" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <Star key={index} size={9} fill="currentColor" strokeWidth={0} />
              ))}
            </span>
            <span className="brand-name">Ramos James Law, PLLC</span>
          </span>
        ) : (
          <img src="/logo.svg" alt="Ramos James Law, PLLC" onError={() => setLogoFailed(true)} />
        )}
      </div>
      <span className="brand-strap">{strap}</span>
    </div>
  );
}
