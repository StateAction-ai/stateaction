import Link from "next/link";
import { Braces, Clapperboard } from "lucide-react";
import { PipelineDiagram } from "./_research/pipeline-diagram";
import { ResearchClip } from "./_research/research-clip";
import styles from "./_research/research.module.css";

export const metadata = {
  title: "Egocentric data for robot learning | StateAction.ai",
  description:
    "Open-source Android capture and processing with free setup and hosting. Request a free sample collection for your robotics research.",
};

const repository = "https://github.com/StateAction-ai/stateaction";
const contact = "mailto:contact@stateaction.ai";
const setup = `${contact}?subject=StateAction%20stack%20setup&body=Lab%20and%20project%3A%0A%0AWhat%20we%20want%20to%20record%3A%0A%0AWhat%20we%20want%20to%20customize%3A%0A`;
const sample = `${contact}?subject=Free%20egocentric%20sample%20collection&body=Lab%20and%20project%3A%0A%0ATask%20and%20environment%3A%0A%0AOutputs%20needed%3A%0A%0AExpected%20volume%20if%20the%20sample%20fits%3A%0A`;

export default function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.inner}>
          <Link href="/" className={styles.brand}>
            StateAction.ai
          </Link>
          <nav aria-label="Research">
            <a href="#stack">Open-source stack</a>
            <a href="#pipeline">Pipeline</a>
            <a href="#collection">Data collection</a>
            <Link href="/login">Sign in</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={`${styles.inner} ${styles.heroGrid}`}>
            <div className={styles.heroIntro}>
              <h1>Open-source egocentric data pipeline</h1>
              <div>
                <p className={styles.lead}>
                  Use the included Android app or adapt the pipeline to your own
                  capture devices. Review action segments, captions, and
                  estimated hand pose in the browser.
                </p>
                <div className={styles.actions}>
                  <a className={styles.primary} href="#stack">
                    Try the open-source pipeline
                  </a>
                  <a className={styles.secondary} href="#collection">
                    Request a free sample
                  </a>
                </div>
              </div>
            </div>
            <ResearchClip />
          </div>
        </section>

        <PipelineDiagram />

        <section
          className={`${styles.inner} ${styles.offers}`}
          aria-label="Ways to work with StateAction"
        >
          <article id="stack" className={styles.offer}>
            <Braces aria-hidden="true" size={29} />
            <h2>Use the open-source stack</h2>
            <p>
              Adapt the Apache-2.0 Android app, processing pipeline, and web
              review console to your lab. Every processing stage is
              customizable. We can help set up and tailor the stack at no
              charge.
            </p>
            <p className={styles.cost}>
              We cover hosting and infrastructure. Provide a Modal access token
              during setup and pay only for your own Modal usage.
            </p>
            <div className={styles.cardActions}>
              <a href={repository}>View source on GitHub</a>
              <a href={setup}>Get setup help</a>
            </div>
          </article>
          <article id="collection" className={styles.offer}>
            <Clapperboard aria-hidden="true" size={29} />
            <h2>Have us collect it</h2>
            <p>
              Tell us the tasks, environments, and outputs you need. We’ll scope
              a free sample collection around your study so you can evaluate the
              data.
            </p>
            <p className={styles.cost}>
              If the sample fits, we can draw on our large network of collectors
              to scale up.
            </p>
            <div className={styles.cardActions}>
              <a href={sample}>Email us for a free sample</a>
            </div>
          </article>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.inner}>
          <Link href="/" className={styles.brand}>
            StateAction.ai
          </Link>
          <a href={contact}>contact@stateaction.ai</a>
        </div>
      </footer>
    </div>
  );
}
