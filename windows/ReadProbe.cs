using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

// Infrastructure probe only. Never opens a handle with write access.
namespace Greenflix.Validation {
    public sealed class ReadResult {
        public long Length;
        public long[] Offsets;
        public long BytesRead;
        public int Workers;
        public bool LargeOffsetsTested;
        public bool HandlesDisposed;
    }

    public static class ReadProbe {
        public static string Failure(Exception error) {
            // PowerShell and Tasks wrap native failures; do not serialize exception messages.
            while (error.InnerException != null) error = error.InnerException;
            int code = error.HResult & 0xffff;
            if (error is UnauthorizedAccessException || code == 5 || code == 65 || code == 86 || code == 1326 || code == 1385)
                return "PERMISSION_DENIED";
            if (code == 53 || code == 64 || code == 67 || code == 121 || code == 1231 || code == 1232 || code == 1203 || code == 2250)
                return "SHARE_UNAVAILABLE";
            if (error is FileNotFoundException || error is DirectoryNotFoundException || code == 2 || code == 3)
                return "NOT_FOUND";
            if (code == 32 || code == 33) return "FILE_BUSY";
            if (error is ArgumentException) return "INVALID_INPUT";
            return "IO_ERROR";
        }

        private static byte[] ReadAt(FileStream stream, long offset, int count) {
            if (stream.Seek(offset, SeekOrigin.Begin) != offset || stream.Position != offset)
                throw new IOException("Seek mismatch.");
            byte[] bytes = new byte[count];
            int total = 0;
            while (total < count) {
                int size = stream.Read(bytes, total, count - total);
                if (size == 0) throw new EndOfStreamException();
                total += size;
            }
            if (stream.Position != offset + count) throw new IOException("Position mismatch.");
            return bytes;
        }

        private static FileStream Open(string file) {
            return new FileStream(file, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.RandomAccess);
        }

        public static ReadResult Run(string file, int workers, int iterations, int bytesPerRead) {
            if (workers < 1 || workers > 20 || iterations < 1 || iterations > 100 || bytesPerRead < 1 || bytesPerRead > 1048576)
                throw new ArgumentException("Bounds.");
            long length;
            long[] offsets;
            byte[][] expected;
            using (FileStream stream = Open(file)) {
                length = stream.Length;
                if (length == 0) throw new IOException("Empty representative file.");
                int count = (int)Math.Min((long)bytesPerRead, length);
                // long throughout: exercise both sides of 2 GiB and 4 GiB when possible.
                offsets = new long[] { 0, length / 2, length - count, 2147483648L, 4294967296L }
                    .Where(x => x <= length - count).Distinct().ToArray();
                expected = offsets.Select(x => ReadAt(stream, x, count)).ToArray();
            }
            Task<long>[] tasks = Enumerable.Range(0, workers).Select(worker => Task.Run(() => {
                long read = 0;
                using (FileStream stream = Open(file)) {
                    if (stream.Length != length) throw new IOException("Representative changed.");
                    for (int pass = 0; pass < iterations; pass++) {
                        for (int index = offsets.Length - 1; index >= 0; index--) {
                            byte[] actual = ReadAt(stream, offsets[index], expected[index].Length);
                            if (!actual.SequenceEqual(expected[index])) throw new IOException("Read mismatch.");
                            read += actual.Length;
                        }
                    }
                    if (stream.Length != length) throw new IOException("Representative changed.");
                }
                return read;
            })).ToArray();
            Task.WaitAll(tasks);
            return new ReadResult { Length = length, Offsets = offsets,
                BytesRead = expected.Sum(x => (long)x.Length) + tasks.Sum(x => x.Result),
                Workers = workers, LargeOffsetsTested = offsets.Contains(2147483648L) && offsets.Contains(4294967296L), HandlesDisposed = true };
        }
    }
}
