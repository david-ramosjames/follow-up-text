import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { useFirm } from "./Firm";

// Other firms get the wordmark, not Ramos James's logo.
export default function BrandBar({ strap = "Client follow-ups" }) {
  const firm = useFirm();
  const name = firm?.current?.name?.trim() || "";
  const showLogo = Boolean(firm?.current?.isDefault);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => { setLogoFailed(false); }, [firm?.current?.id]);

  const wordmark = (
    <span className="brand-fallback">
      <span className="brand-stars" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <Star key={index} size={9} fill="currentColor" strokeWidth={0} />
        ))}
      </span>
      <span className="brand-name">{name}</span>
    </span>
  );

  return (
    <div className="brand-bar">
      <div className="brand-mark">
        {showLogo && !logoFailed ? (
          <img src="/logo.svg" alt={name || "Ramos James Law, PLLC"} onError={() => setLogoFailed(true)} />
        ) : (
          wordmark
        )}
      </div>
      <span className="brand-strap">{strap}</span>
    </div>
  );
}
