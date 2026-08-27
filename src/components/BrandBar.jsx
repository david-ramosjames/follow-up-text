import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { useFirm } from "./Firm";

export default function BrandBar({ strap = "Client follow-ups" }) {
  const firm = useFirm();
  const current = firm?.current;
  const name = current?.name?.trim() || "";
  const showSwitcher = (firm?.firms?.length ?? 0) > 1;
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => { setLogoFailed(false); }, [current?.id]);

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
        {!current && !logoFailed ? (
          <img src="/logo.svg" alt="Ramos James Law, PLLC" onError={() => setLogoFailed(true)} />
        ) : !current ? (
          <span className="brand-fallback">
            <span className="brand-stars" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <Star key={index} size={9} fill="currentColor" strokeWidth={0} />
              ))}
            </span>
            <span className="brand-name">Ramos James Law, PLLC</span>
          </span>
        ) : (
          wordmark
        )}
      </div>
      <div className="brand-bar-end">
        <span className="brand-strap">{strap}</span>
        {showSwitcher && (
          <label className="firm-switch">
            <select
              value={current?.id ?? ""}
              onChange={(event) => firm.switchFirm(event.target.value)}
              aria-label="Switch firm"
            >
              {firm.firms.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
