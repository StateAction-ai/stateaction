package open.fpvlabs.stera.upload

import java.util.concurrent.atomic.AtomicLong

/**
 * Admission check for a normal (queued) bridge call against logout/unbind invalidations received after it.
 *
 * Order matters: the gate sequence snapshot is read FIRST, the receipt counter SECOND. An invalidation always
 * bumps the receipt counter before it fences the gate, so:
 *  - arrival before the snapshot: the call's own [receiptAtCall] is already behind the counter -> refused;
 *  - arrival between snapshot and check: the counter moved -> refused;
 *  - arrival after the check: the snapshot is older than the (later) fence -> the runtime/gate re-check of this
 *    exact snapshot refuses it.
 * Reading them in the other order would let an old call pick up the NEW gate sequence and pass after cleanup.
 */
class CallFence(private val receipts: AtomicLong, private val gateSeq: () -> Long) {
    fun next(): Long = receipts.get()

    /** The gate sequence snapshot to pass to the runtime, or [SupersededException] if an invalidation arrived since the call. */
    fun admit(receiptAtCall: Long): Long {
        val snapshot = gateSeq()
        if (receipts.get() != receiptAtCall) throw SupersededException()
        return snapshot
    }
}
