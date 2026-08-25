import './jwt.test';
import './password.test';
import './ics.test';
import './heuristic.test';
import './core.test';
import './push.test';
import './infra.test';
// Last on purpose: this one redirects config.dbPath at its own suite's `before`
// and restores it in `after`, so it should not run while another suite holds a
// database handle.
import './http.test';
