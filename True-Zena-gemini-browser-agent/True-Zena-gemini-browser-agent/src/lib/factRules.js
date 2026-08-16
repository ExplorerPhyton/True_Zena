export const verdictMeta = {
  true: {
    label: "Likely true",
    tone: "true",
    score: 92,
  },
  false: {
    label: "Likely false",
    tone: "false",
    score: 90,
  },
  misleading: {
    label: "Misleading",
    tone: "misleading",
    score: 78,
  },
  unsupported: {
    label: "Unsupported",
    tone: "unsupported",
    score: 58,
  },
  context: {
    label: "Needs context",
    tone: "context",
    score: 52,
  },
};

export const sourceQuality = {
  official: "Official",
  science: "Scientific",
  factcheck: "Fact-check",
  reference: "Reference",
};

export const factRules = [
  {
    id: "australia-capital",
    topic: "Geography",
    test: (claim) =>
      /capital of australia|australia'?s capital|australian capital|sydney.*capital.*australia|canberra.*capital.*australia/i.test(
        claim
      ),
    result: (claim) => {
      const saysSydney = /sydney/i.test(claim);
      const saysCanberra = /canberra/i.test(claim);

      if (saysCanberra && !saysSydney) {
        return {
          verdict: "true",
          type: "Verified civic fact",
          reason: "The claim matches the established capital city of Australia.",
          correction: "Australia's capital is Canberra.",
          evidence: [
            {
              title: "Parliament of Australia - Canberra",
              url: "https://www.aph.gov.au/About_Parliament/Parliament_House/Canberra",
              quality: "official",
            },
          ],
        };
      }

      return {
        verdict: "false",
        type: "False location claim",
        reason:
          "The claim names Sydney as the capital, but Australia's capital is Canberra. Sydney is the capital of New South Wales.",
        correction: "Australia's capital is Canberra, not Sydney.",
        evidence: [
          {
            title: "Parliament of Australia - Canberra",
            url: "https://www.aph.gov.au/About_Parliament/Parliament_House/Canberra",
            quality: "official",
          },
          {
            title: "Australian Government - About Australia",
            url: "https://www.australia.gov.au/about-australia",
            quality: "official",
          },
        ],
      };
    },
  },
  {
    id: "ethiopia-capital",
    topic: "Geography",
    test: (claim) =>
      /capital of ethiopia|ethiopia'?s capital|addis ababa.*capital.*ethiopia|nairobi.*capital.*ethiopia/i.test(
        claim
      ),
    result: (claim) => {
      if (/addis ababa/i.test(claim) && !/nairobi/i.test(claim)) {
        return {
          verdict: "true",
          type: "Verified civic fact",
          reason: "The claim matches the internationally recognized capital city of Ethiopia.",
          correction: "Ethiopia's capital is Addis Ababa.",
          evidence: [
            {
              title: "CIA World Factbook - Ethiopia",
              url: "https://www.cia.gov/the-world-factbook/countries/ethiopia/",
              quality: "reference",
            },
          ],
        };
      }

      return {
        verdict: "false",
        type: "False location claim",
        reason:
          "The claim conflicts with reference sources: Ethiopia's capital is Addis Ababa. Nairobi is the capital of Kenya.",
        correction: "Ethiopia's capital is Addis Ababa.",
        evidence: [
          {
            title: "CIA World Factbook - Ethiopia",
            url: "https://www.cia.gov/the-world-factbook/countries/ethiopia/",
            quality: "reference",
          },
        ],
      };
    },
  },
  {
    id: "flat-earth",
    topic: "Science",
    test: (claim) =>
      /earth is flat|flat earth|planet is flat|globe is fake/i.test(claim),
    result: () => ({
      verdict: "false",
      type: "Scientific falsehood",
      reason:
        "The claim contradicts centuries of measurement, satellite imagery, navigation, and direct observation from space.",
      correction: "Earth is an oblate spheroid, not flat.",
      evidence: [
        {
          title: "NASA - Earth Observatory",
          url: "https://earthobservatory.nasa.gov/",
          quality: "official",
        },
        {
          title: "NOAA - Geodesy",
          url: "https://geodesy.noaa.gov/",
          quality: "science",
        },
      ],
    }),
  },
  {
    id: "vaccines-autism",
    topic: "Health",
    test: (claim) =>
      /vaccines?.*(cause|causes|caused|linked to).*autism|autism.*(caused by|from).*vaccines?/i.test(
        claim
      ),
    result: () => ({
      verdict: "false",
      type: "Medical misinformation",
      reason:
        "Large studies have not found a causal link between vaccines and autism. The claim repeats a widely debunked health myth.",
      correction: "Vaccines do not cause autism.",
      evidence: [
        {
          title: "CDC - Vaccines and Autism",
          url: "https://www.cdc.gov/vaccine-safety/about/autism.html",
          quality: "official",
        },
        {
          title: "WHO - Vaccine safety",
          url: "https://www.who.int/teams/regulation-prequalification/regulation-and-safety/pharmacovigilance/health-professionals-info/vaccine-safety",
          quality: "official",
        },
      ],
    }),
  },
  {
    id: "dna-vaccine",
    topic: "Health",
    test: (claim) =>
      /(mrna|covid).*vaccines?.*(change|alter|rewrite).*dna|dna.*(changed|altered|rewritten).*vaccines?/i.test(
        claim
      ),
    result: () => ({
      verdict: "false",
      type: "Medical misinformation",
      reason:
        "mRNA vaccines do not enter the cell nucleus where DNA is stored, so they do not change a person's DNA.",
      correction: "mRNA COVID-19 vaccines do not change human DNA.",
      evidence: [
        {
          title: "CDC - Understanding mRNA COVID-19 vaccines",
          url: "https://www.cdc.gov/covid/vaccines/how-they-work.html",
          quality: "official",
        },
      ],
    }),
  },
  {
    id: "bleach-covid",
    topic: "Health",
    test: (claim) =>
      /(bleach|disinfectant).*(cure|treat|prevent).*covid|covid.*(cured|treated|prevented).*(bleach|disinfectant)/i.test(
        claim
      ),
    result: () => ({
      verdict: "false",
      type: "Dangerous health claim",
      reason:
        "Bleach and disinfectants are poisonous when swallowed or injected. They are not treatments for COVID-19.",
      correction: "Do not ingest or inject disinfectants. Use medical advice from qualified health authorities.",
      evidence: [
        {
          title: "FDA - Fraudulent Coronavirus Disease 2019 products",
          url: "https://www.fda.gov/consumers/health-fraud-scams/fraudulent-coronavirus-disease-2019-covid-19-products",
          quality: "official",
        },
        {
          title: "CDC - Poison prevention",
          url: "https://www.cdc.gov/cleaning-safety/prevention/index.html",
          quality: "official",
        },
      ],
    }),
  },
  {
    id: "fiveg-covid",
    topic: "Technology",
    test: (claim) =>
      /(5g|cell towers?).*(cause|spread|created).*covid|covid.*(caused by|spread by|created by).*(5g|cell towers?)/i.test(
        claim
      ),
    result: () => ({
      verdict: "false",
      type: "Conspiracy claim",
      reason:
        "COVID-19 is caused by the SARS-CoV-2 virus. Radio signals from 5G networks do not create or transmit viruses.",
      correction: "COVID-19 is caused by a virus, not by 5G technology.",
      evidence: [
        {
          title: "WHO - Coronavirus disease advice",
          url: "https://www.who.int/emergencies/diseases/novel-coronavirus-2019/advice-for-public/myth-busters",
          quality: "official",
        },
      ],
    }),
  },
  {
    id: "climate-hoax",
    topic: "Climate",
    test: (claim) =>
      /climate change.*(hoax|fake|not real)|global warming.*(hoax|fake|not real)|humans?.*not.*cause.*climate change/i.test(
        claim
      ),
    result: () => ({
      verdict: "false",
      type: "Scientific falsehood",
      reason:
        "Multiple lines of evidence show that recent climate change is real and primarily driven by human activity, especially greenhouse gas emissions.",
      correction: "Human-driven climate change is real and strongly supported by scientific evidence.",
      evidence: [
        {
          title: "NASA - Evidence for climate change",
          url: "https://climate.nasa.gov/evidence/",
          quality: "official",
        },
        {
          title: "IPCC - Sixth Assessment Report",
          url: "https://www.ipcc.ch/assessment-report/ar6/",
          quality: "science",
        },
      ],
    }),
  },
  {
    id: "great-wall-space",
    topic: "Space",
    test: (claim) =>
      /great wall.*(visible|seen).*(space|moon)|space.*see.*great wall/i.test(
        claim
      ),
    result: () => ({
      verdict: "misleading",
      type: "Overstated fact",
      reason:
        "The claim is often repeated, but the Great Wall is not easily visible to the unaided eye from low Earth orbit and is not visible from the Moon.",
      correction: "The Great Wall is difficult to see from orbit without aid and cannot be seen from the Moon by the naked eye.",
      evidence: [
        {
          title: "NASA - The Great Wall from space",
          url: "https://www.nasa.gov/image-article/great-wall/",
          quality: "official",
        },
      ],
    }),
  },
  {
    id: "moon-landing-fake",
    topic: "Space",
    test: (claim) =>
      /moon landing.*(fake|hoax|staged)|apollo.*(fake|hoax|staged)/i.test(
        claim
      ),
    result: () => ({
      verdict: "false",
      type: "Conspiracy claim",
      reason:
        "The Apollo landings are supported by mission records, independent tracking, lunar samples, and equipment still observed on the Moon.",
      correction: "The Apollo Moon landings happened.",
      evidence: [
        {
          title: "NASA - Apollo missions",
          url: "https://www.nasa.gov/the-apollo-program/",
          quality: "official",
        },
      ],
    }),
  },
  {
    id: "brain-ten-percent",
    topic: "Health",
    test: (claim) =>
      /(use|uses|using).*only.*10%.*brain|10%.*of.*brain/i.test(claim),
    result: () => ({
      verdict: "false",
      type: "Popular myth",
      reason:
        "Brain imaging and clinical evidence show that people use far more than 10 percent of the brain across normal activities.",
      correction: "Humans use many regions of the brain, not just 10 percent.",
      evidence: [
        {
          title: "Britannica - Do we really use only 10 percent of our brain?",
          url: "https://www.britannica.com/story/do-we-really-use-only-10-percent-of-our-brain",
          quality: "reference",
        },
      ],
    }),
  },
  {
    id: "sugar-hyperactivity",
    topic: "Health",
    test: (claim) =>
      /sugar.*(causes|makes).*hyperactive|kids?.*hyperactive.*sugar/i.test(
        claim
      ),
    result: () => ({
      verdict: "misleading",
      type: "Oversimplified health claim",
      reason:
        "Sugar can affect diet and health, but controlled studies have not shown a simple direct effect where sugar reliably causes hyperactivity in children.",
      correction: "Sugar is not proven to directly cause hyperactivity in children.",
      evidence: [
        {
          title: "JAMA Pediatrics - Sugar and behavior meta-analysis",
          url: "https://jamanetwork.com/journals/jama/article-abstract/391812",
          quality: "science",
        },
      ],
    }),
  },
];
