export interface PublicCompanyProfile {
  legalName: string;
  website: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
  publicEmail: string;
  products: string[];
  sourceUrl: string;
  verifiedAt: string;
}

export const TUDELU_PUBLIC_PROFILE: PublicCompanyProfile = {
  legalName: "Tudelu Holdings, LLC",
  website: "https://tudelu.com/",
  addressLine1: "100 Industrial Avenue",
  city: "Little Ferry",
  state: "NJ",
  postalCode: "07643",
  phone: "718-782-7882",
  publicEmail: "info@tudelu.com",
  products: [
    "architectural canopy systems",
    "motorized retractable partition walls",
    "pergola systems",
    "architectural elements",
  ],
  sourceUrl: "https://tudelu.com/",
  verifiedAt: "2026-07-16",
};

export const REGISTRATION_FIELDS_REQUIRING_OWNER_CONFIRMATION = [
  "authorized representative and job title",
  "registration email and verification codes",
  "EIN, W-9, and tax classification",
  "UEI/CAGE or state supplier identifiers",
  "insurance, licenses, and certification claims",
  "banking or payment details",
  "portal terms, attestations, and electronic signatures",
] as const;
