import { installPiRespondent } from '../src/pi-integration.js';

// Loading the package registers capabilities only. Attachment is explicit.
export default function sillage(pi) { installPiRespondent(pi); }
